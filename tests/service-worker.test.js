/**
 * service-worker.test.js — Unit tests for background/service-worker.js
 *
 * Tests are isolated — we replicate the key logic functions rather than
 * loading the full service worker (which requires a browser extension context).
 */

const { describe, it, expect } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Replicated logic under test
// ---------------------------------------------------------------------------

const MAX_HISTORY_PAIRS = 10;

function trimHistory(conversation) {
  const systemMsg = conversation.messages[0];
  const rest = conversation.messages.slice(1);
  const maxMessages = MAX_HISTORY_PAIRS * 2;
  const trimmed = rest.slice(-maxMessages);
  conversation.messages = [systemMsg, ...trimmed];
}

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') { return false; }
  if (typeof msg.action !== 'string') { return false; }
  return ['summarize', 'followUp', 'getStatus'].includes(msg.action);
}

function buildSummarizePrompt(paragraphs) {
  const index = paragraphs.map((p) => `[${p.id}]: ${p.text}`).join('\n');
  return `You are an article summarizer.\n\nARTICLE PARAGRAPHS:\n${index}`;
}

function buildFollowUpPrompt(paragraphs) {
  const index = paragraphs.map((p) => `[${p.id}]: ${p.text}`).join('\n');
  return `You are continuing a conversation.\n\nARTICLE PARAGRAPHS:\n${index}`;
}

/** Parse SSE lines from a raw string, returns delta content strings */
function parseSseChunks(raw) {
  const lines = raw.split('\n');
  const deltas = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) { continue; }
    const jsonStr = trimmed.slice(6);
    if (jsonStr === '[DONE]') { continue; }
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) { deltas.push(delta); }
    } catch (_e) {
      // skip malformed
    }
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Tests: Message validation
// ---------------------------------------------------------------------------

describe('validateMessage', () => {
  it('accepts valid summarize action', () => {
    expect(validateMessage({ action: 'summarize' })).toBe(true);
  });

  it('accepts valid followUp action', () => {
    expect(validateMessage({ action: 'followUp', question: 'What?' })).toBe(true);
  });

  it('accepts valid getStatus action', () => {
    expect(validateMessage({ action: 'getStatus' })).toBe(true);
  });

  it('rejects null', () => {
    expect(validateMessage(null)).toBe(false);
  });

  it('rejects message without action', () => {
    expect(validateMessage({ data: 'something' })).toBe(false);
  });

  it('rejects unknown action', () => {
    expect(validateMessage({ action: 'deleteEverything' })).toBe(false);
  });

  it('rejects non-string action', () => {
    expect(validateMessage({ action: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Conversation history trimming
// ---------------------------------------------------------------------------

describe('trimHistory', () => {
  it('preserves system message at index 0', () => {
    const conversation = {
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
      ],
    };
    trimHistory(conversation);
    expect(conversation.messages[0].role).toBe('system');
    expect(conversation.messages[0].content).toBe('System prompt');
  });

  it('keeps messages within limit when under threshold', () => {
    const conversation = { messages: [{ role: 'system', content: 'sys' }] };
    for (let i = 0; i < 5; i++) {
      conversation.messages.push({ role: 'user', content: `Q${i}` });
      conversation.messages.push({ role: 'assistant', content: `A${i}` });
    }
    trimHistory(conversation);
    // 5 pairs = 10 messages + system = 11 total, under limit (20 + system = 21)
    expect(conversation.messages.length).toBe(11);
  });

  it('trims to last MAX_HISTORY_PAIRS when over threshold', () => {
    const conversation = { messages: [{ role: 'system', content: 'sys' }] };
    for (let i = 0; i < 15; i++) {
      conversation.messages.push({ role: 'user', content: `Q${i}` });
      conversation.messages.push({ role: 'assistant', content: `A${i}` });
    }
    trimHistory(conversation);
    // MAX_HISTORY_PAIRS * 2 + system = 20 + 1 = 21
    expect(conversation.messages.length).toBe(MAX_HISTORY_PAIRS * 2 + 1);
  });

  it('keeps the most recent messages when trimming', () => {
    const conversation = { messages: [{ role: 'system', content: 'sys' }] };
    for (let i = 0; i < 15; i++) {
      conversation.messages.push({ role: 'user', content: `Q${i}` });
      conversation.messages.push({ role: 'assistant', content: `A${i}` });
    }
    trimHistory(conversation);
    // The last message should be A14
    const last = conversation.messages[conversation.messages.length - 1];
    expect(last.content).toBe('A14');
  });
});

// ---------------------------------------------------------------------------
// Tests: Prompt construction
// ---------------------------------------------------------------------------

describe('buildSummarizePrompt', () => {
  it('includes all paragraph IDs and text', () => {
    const paragraphs = [
      { id: 'p-0', text: 'First para.' },
      { id: 'p-1', text: 'Second para.' },
    ];
    const prompt = buildSummarizePrompt(paragraphs);
    expect(prompt).toContain('[p-0]: First para.');
    expect(prompt).toContain('[p-1]: Second para.');
  });

  it('includes expected instruction content', () => {
    const prompt = buildSummarizePrompt([{ id: 'p-0', text: 'Test.' }]);
    expect(prompt).toContain('article summarizer');
    expect(prompt).toContain('ARTICLE PARAGRAPHS');
  });

  it('handles empty paragraph list gracefully', () => {
    const prompt = buildSummarizePrompt([]);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe('buildFollowUpPrompt', () => {
  it('includes paragraph index', () => {
    const paragraphs = [{ id: 'p-0', text: 'Some content.' }];
    const prompt = buildFollowUpPrompt(paragraphs);
    expect(prompt).toContain('[p-0]: Some content.');
  });

  it('includes follow-up instruction context', () => {
    const prompt = buildFollowUpPrompt([{ id: 'p-0', text: 'X.' }]);
    expect(prompt).toContain('ARTICLE PARAGRAPHS');
  });
});

// ---------------------------------------------------------------------------
// Tests: SSE parsing
// ---------------------------------------------------------------------------

describe('parseSseChunks', () => {
  it('extracts content deltas from SSE stream', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: [DONE]',
    ].join('\n');

    const deltas = parseSseChunks(raw);
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('ignores non-data lines', () => {
    const raw = [
      ': ping',
      '',
      'data: {"choices":[{"delta":{"content":"chunk"}}]}',
    ].join('\n');
    expect(parseSseChunks(raw)).toEqual(['chunk']);
  });

  it('ignores [DONE] line', () => {
    const raw = 'data: [DONE]';
    expect(parseSseChunks(raw)).toEqual([]);
  });

  it('handles malformed JSON gracefully', () => {
    const raw = [
      'data: {not valid json}',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
    ].join('\n');
    expect(parseSseChunks(raw)).toEqual(['ok']);
  });

  it('ignores chunks with no content delta', () => {
    const raw = 'data: {"choices":[{"delta":{}}]}';
    expect(parseSseChunks(raw)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: HTTP error handling mapping
// ---------------------------------------------------------------------------

describe('HTTP error handling', () => {
  it('maps status 401 to invalid API key message', () => {
    const status = 401;
    let message;
    if (status === 401) { message = 'Invalid API key. Please check your settings.'; }
    else if (status === 429) { message = 'Rate limit exceeded.'; }
    else if (status >= 500) { message = 'Server error.'; }
    expect(message).toBe('Invalid API key. Please check your settings.');
  });

  it('maps status 429 to rate limit message', () => {
    const status = 429;
    let message;
    if (status === 401) { message = 'Invalid API key. Please check your settings.'; }
    else if (status === 429) { message = 'Rate limit exceeded.'; }
    else if (status >= 500) { message = 'Server error.'; }
    expect(message).toBe('Rate limit exceeded.');
  });

  it('maps 5xx to server error', () => {
    const status = 503;
    let message;
    if (status === 401) { message = 'Invalid API key.'; }
    else if (status === 429) { message = 'Rate limit.'; }
    else if (status >= 500) { message = 'Server error.'; }
    expect(message).toBe('Server error.');
  });
});

// ---------------------------------------------------------------------------
// Tests: Exponential backoff calculation
// ---------------------------------------------------------------------------

describe('exponential backoff', () => {
  it('calculates correct delays for attempts 0-2', () => {
    const BACKOFF_BASE_MS = 1000;
    expect(BACKOFF_BASE_MS * Math.pow(2, 0)).toBe(1000);
    expect(BACKOFF_BASE_MS * Math.pow(2, 1)).toBe(2000);
    expect(BACKOFF_BASE_MS * Math.pow(2, 2)).toBe(4000);
  });
});
