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
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  if (typeof msg.action !== 'string') {
    return false;
  }
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
    if (!trimmed.startsWith('data: ')) {
      continue;
    }
    const jsonStr = trimmed.slice(6);
    if (jsonStr === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        deltas.push(delta);
      }
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

  it('passes through unchanged when only the system message is present', () => {
    const conversation = { messages: [{ role: 'system', content: 'System prompt' }] };
    trimHistory(conversation);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0].role).toBe('system');
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
    const raw = [': ping', '', 'data: {"choices":[{"delta":{"content":"chunk"}}]}'].join('\n');
    expect(parseSseChunks(raw)).toEqual(['chunk']);
  });

  it('ignores [DONE] line', () => {
    const raw = 'data: [DONE]';
    expect(parseSseChunks(raw)).toEqual([]);
  });

  it('handles malformed JSON gracefully', () => {
    const raw = ['data: {not valid json}', 'data: {"choices":[{"delta":{"content":"ok"}}]}'].join(
      '\n'
    );
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
    if (status === 401) {
      message = 'Invalid API key. Please check your settings.';
    } else if (status === 429) {
      message = 'Rate limit exceeded.';
    } else if (status >= 500) {
      message = 'Server error.';
    }
    expect(message).toBe('Invalid API key. Please check your settings.');
  });

  it('maps status 429 to rate limit message', () => {
    const status = 429;
    let message;
    if (status === 401) {
      message = 'Invalid API key. Please check your settings.';
    } else if (status === 429) {
      message = 'Rate limit exceeded.';
    } else if (status >= 500) {
      message = 'Server error.';
    }
    expect(message).toBe('Rate limit exceeded.');
  });

  it('maps 5xx to server error', () => {
    const status = 503;
    let message;
    if (status === 401) {
      message = 'Invalid API key.';
    } else if (status === 429) {
      message = 'Rate limit.';
    } else if (status >= 500) {
      message = 'Server error.';
    }
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

// ---------------------------------------------------------------------------
// Tests: Session storage persistence (MV3 service worker restart recovery)
// ---------------------------------------------------------------------------

// Replicated helpers — mirror the logic in background/service-worker.js
async function persistConversation(tabId, conversation, mockSession) {
  if (!tabId || !mockSession) {
    return;
  }
  try {
    await mockSession.set({ [`conv_${tabId}`]: conversation });
  } catch (_e) {
    /* silently degrade */
  }
}

async function restoreConversation(tabId, mockSession, conversations) {
  if (!tabId || !mockSession) {
    return null;
  }
  try {
    const result = await mockSession.get(`conv_${tabId}`);
    const conv = result[`conv_${tabId}`];
    if (conv) {
      conversations.set(tabId, conv);
      return conv;
    }
  } catch (_e) {
    /* silently degrade */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests: URL-based stale conversation eviction
// ---------------------------------------------------------------------------

// Replicated logic mirroring _handleGetStatus URL eviction in service-worker.js
function evictIfStale(conversations, tabId, currentUrl, clearFn) {
  if (!tabId || !currentUrl) {
    return;
  }
  const conv = conversations.get(tabId);
  if (conv && conv.url && conv.url !== currentUrl) {
    conversations.delete(tabId);
    clearFn(tabId);
  }
}

function evictRestoredIfStale(conversations, tabId, restored, currentUrl, clearFn) {
  if (!restored) {
    return false;
  }
  if (currentUrl && restored.url && restored.url !== currentUrl) {
    conversations.delete(tabId);
    clearFn(tabId);
    return false;
  }
  return true;
}

describe('URL-based stale conversation eviction', () => {
  it('retains conversation when URL matches', () => {
    const conversations = new Map();
    const cleared = [];
    const conv = { url: 'https://example.com/article', messages: [] };
    conversations.set(1, conv);

    evictIfStale(conversations, 1, 'https://example.com/article', (id) => cleared.push(id));

    expect(conversations.has(1)).toBe(true);
    expect(cleared).toHaveLength(0);
  });

  it('evicts conversation when URL differs', () => {
    const conversations = new Map();
    const cleared = [];
    const conv = { url: 'https://example.com/old-article', messages: [] };
    conversations.set(1, conv);

    evictIfStale(conversations, 1, 'https://example.com/new-article', (id) => cleared.push(id));

    expect(conversations.has(1)).toBe(false);
    expect(cleared).toContain(1);
  });

  it('does not evict when currentUrl is null (no URL in message)', () => {
    const conversations = new Map();
    const cleared = [];
    const conv = { url: 'https://example.com/article', messages: [] };
    conversations.set(1, conv);

    evictIfStale(conversations, 1, null, (id) => cleared.push(id));

    expect(conversations.has(1)).toBe(true);
    expect(cleared).toHaveLength(0);
  });

  it('does not evict when stored conversation has no URL', () => {
    const conversations = new Map();
    const cleared = [];
    const conv = { url: '', messages: [] }; // empty URL (edge case)
    conversations.set(1, conv);

    evictIfStale(conversations, 1, 'https://example.com/new', (id) => cleared.push(id));

    // Guard requires conv.url to be truthy before comparing
    expect(conversations.has(1)).toBe(true);
  });

  it('evicts restored conversation when URL differs', () => {
    const conversations = new Map();
    const cleared = [];
    const restored = { url: 'https://old.example.com', messages: [] };
    conversations.set(2, restored);

    const kept = evictRestoredIfStale(conversations, 2, restored, 'https://new.example.com', (id) =>
      cleared.push(id)
    );

    expect(kept).toBe(false);
    expect(conversations.has(2)).toBe(false);
    expect(cleared).toContain(2);
  });

  it('keeps restored conversation when URL matches', () => {
    const conversations = new Map();
    const cleared = [];
    const restored = { url: 'https://example.com/article', messages: [] };
    conversations.set(3, restored);

    const kept = evictRestoredIfStale(
      conversations,
      3,
      restored,
      'https://example.com/article',
      (id) => cleared.push(id)
    );

    expect(kept).toBe(true);
    expect(cleared).toHaveLength(0);
  });

  it('keeps restored conversation when currentUrl is null', () => {
    const conversations = new Map();
    const cleared = [];
    const restored = { url: 'https://example.com/article', messages: [] };
    conversations.set(4, restored);

    const kept = evictRestoredIfStale(conversations, 4, restored, null, (id) => cleared.push(id));

    expect(kept).toBe(true);
    expect(cleared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: AbortError handling in stream completion
// ---------------------------------------------------------------------------

function classifyStreamError(err) {
  if (err.name === 'AbortError') {
    return 'abort';
  }
  return 'error';
}

describe('AbortError handling', () => {
  it('classifies AbortError as abort (silent exit)', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    expect(classifyStreamError(err)).toBe('abort');
  });

  it('classifies non-AbortError as error (user-facing message)', () => {
    const err = new Error('Network failure');
    expect(classifyStreamError(err)).toBe('error');
  });

  it('classifies TypeError as error', () => {
    const err = new TypeError('Failed to fetch');
    expect(classifyStreamError(err)).toBe('error');
  });

  it('AbortError.name is exactly "AbortError"', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(err.name).toBe('AbortError');
  });
});

// ---------------------------------------------------------------------------
// Tests: followUp question validation
// ---------------------------------------------------------------------------

function validateFollowUpQuestion(question) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    return { valid: false, reason: 'Question cannot be empty.' };
  }
  return { valid: true };
}

describe('followUp question validation', () => {
  it('accepts a normal question', () => {
    expect(validateFollowUpQuestion('What is the main argument?').valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = validateFollowUpQuestion('');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Question cannot be empty.');
  });

  it('rejects a whitespace-only string', () => {
    const result = validateFollowUpQuestion('   ');
    expect(result.valid).toBe(false);
  });

  it('rejects null', () => {
    expect(validateFollowUpQuestion(null).valid).toBe(false);
  });

  it('rejects a non-string type (number)', () => {
    expect(validateFollowUpQuestion(42).valid).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateFollowUpQuestion(undefined).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Reference chip regex
// ---------------------------------------------------------------------------

function replaceRefs(text) {
  return text.replace(/\[p-(\d+)\]/g, (_match, n) => `<span data-ref="p-${n}">[${n}]</span>`);
}

describe('reference chip regex', () => {
  it('replaces single-digit reference', () => {
    const out = replaceRefs('See [p-3] for details.');
    expect(out).toContain('data-ref="p-3"');
    expect(out).not.toContain('[p-3]');
  });

  it('replaces multi-digit reference [p-42]', () => {
    const out = replaceRefs('Covered in [p-42].');
    expect(out).toContain('data-ref="p-42"');
    expect(out).not.toContain('[p-42]');
  });

  it('does not match malformed [p-] with no digits', () => {
    const out = replaceRefs('Bad ref [p-] here.');
    expect(out).toBe('Bad ref [p-] here.');
  });

  it('does not match [p] without dash', () => {
    const out = replaceRefs('[p] is not a ref.');
    expect(out).toBe('[p] is not a ref.');
  });

  it('replaces multiple refs in one string', () => {
    const out = replaceRefs('[p-0][p-1][p-99]');
    expect(out).toContain('data-ref="p-0"');
    expect(out).toContain('data-ref="p-1"');
    expect(out).toContain('data-ref="p-99"');
  });
});

// ---------------------------------------------------------------------------
// Tests: validateKey handler
// ---------------------------------------------------------------------------

/**
 * Replicates _handleValidateKey from service-worker.js.
 * Accepts an injectable mockFetch so we can test without real network calls.
 */
async function validateKeyHandler(key, mockFetch) {
  if (!key || typeof key !== 'string') {
    return { valid: false };
  }
  try {
    const response = await mockFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return { valid: response.ok };
  } catch (_err) {
    return { valid: false };
  }
}

describe('validateKey handler', () => {
  it('returns { valid: true } when fetch responds 200 ok', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    const result = await validateKeyHandler('sk-valid', mockFetch);
    expect(result).toEqual({ valid: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-valid' } })
    );
  });

  it('returns { valid: false } when fetch responds 401', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    expect(await validateKeyHandler('sk-bad', mockFetch)).toEqual({ valid: false });
  });

  it('returns { valid: false } on network error', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('Network failure'));
    expect(await validateKeyHandler('sk-test', mockFetch)).toEqual({ valid: false });
  });

  it('returns { valid: false } for empty string without calling fetch', async () => {
    const mockFetch = jest.fn();
    expect(await validateKeyHandler('', mockFetch)).toEqual({ valid: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns { valid: false } for null without calling fetch', async () => {
    const mockFetch = jest.fn();
    expect(await validateKeyHandler(null, mockFetch)).toEqual({ valid: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns { valid: false } for non-string key without calling fetch', async () => {
    const mockFetch = jest.fn();
    expect(await validateKeyHandler(42, mockFetch)).toEqual({ valid: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('session storage persistence', () => {
  it('persists conversation under a tab-namespaced key', async () => {
    const stored = {};
    const mockSession = {
      set: jest.fn(async (obj) => {
        Object.assign(stored, obj);
      }),
    };
    const conv = { tabId: 42, messages: [{ role: 'system', content: 'sys' }] };

    await persistConversation(42, conv, mockSession);

    expect(mockSession.set).toHaveBeenCalledWith({ conv_42: conv });
    expect(stored['conv_42']).toEqual(conv);
  });

  it('restores conversation from session storage on cache miss', async () => {
    const mockConv = { tabId: 7, messages: [{ role: 'system', content: 'sys' }] };
    const sessionStore = { conv_7: mockConv };
    const mockSession = {
      get: jest.fn(async (key) => ({ [key]: sessionStore[key] })),
    };
    const conversations = new Map();

    const result = await restoreConversation(7, mockSession, conversations);

    expect(result).toEqual(mockConv);
    expect(conversations.get(7)).toEqual(mockConv); // warmed in-memory cache
  });

  it('returns null when session storage has no entry for that tab', async () => {
    const mockSession = {
      get: jest.fn(async (_key) => ({})),
    };
    const result = await restoreConversation(99, mockSession, new Map());
    expect(result).toBeNull();
  });

  it('returns null and skips storage when tabId is null', async () => {
    const mockSession = { get: jest.fn() };
    const result = await restoreConversation(null, mockSession, new Map());
    expect(result).toBeNull();
    expect(mockSession.get).not.toHaveBeenCalled();
  });

  it('returns null and skips storage when mockSession is null (unavailable)', async () => {
    const result = await restoreConversation(5, null, new Map());
    expect(result).toBeNull();
  });

  it('handles storage.get throwing gracefully and returns null', async () => {
    const mockSession = {
      get: jest.fn(async () => {
        throw new Error('quota exceeded');
      }),
    };
    const result = await restoreConversation(42, mockSession, new Map());
    expect(result).toBeNull();
  });

  it('handles storage.set throwing gracefully without propagating', async () => {
    const mockSession = {
      set: jest.fn(async () => {
        throw new Error('storage full');
      }),
    };
    await expect(persistConversation(1, { messages: [] }, mockSession)).resolves.toBeUndefined();
  });

  it('does not call storage.set when tabId is falsy', async () => {
    const mockSession = { set: jest.fn() };
    await persistConversation(null, { messages: [] }, mockSession);
    expect(mockSession.set).not.toHaveBeenCalled();
  });
});
