/**
 * service-worker.js — Background service worker / background script.
 *
 * Responsibilities:
 *  - Securely proxy all OpenAI API calls (API key never exposed to content scripts)
 *  - Manage per-tab conversation history in memory
 *  - Stream SSE response chunks back to content scripts via ports
 *  - Handle errors, rate limits, and retries with exponential backoff
 *
 * Message protocol (chrome.runtime.onConnect port name: "summarizer"):
 *   Content → Background:  { action: "summarize"|"followUp"|"getStatus", ...payload }
 *   Background → Content:  { type: "chunk", content: string }
 *                           { type: "done" }
 *                           { type: "error", message: string }
 *                           { type: "status", hasApiKey: boolean, hasConversation: boolean }
 */

// Cross-browser shim — `browser` is native in Firefox; Chrome uses `chrome` in service workers
// eslint-disable-next-line no-redeclare
const browser = globalThis.browser || globalThis.chrome;

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ARTICLE_CHARS = 48000;
const MAX_HISTORY_PAIRS = 10;

/** @type {Map<number, Conversation>} Per-tab conversation store */
const conversations = new Map();

/**
 * @typedef {Object} Message
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} Conversation
 * @property {number} tabId
 * @property {string} url
 * @property {string} articleText
 * @property {{ id: string, text: string }[]} paragraphs
 * @property {Message[]} messages
 */

// ---------------------------------------------------------------------------
// Port-based message handling (for streaming)
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'summarizer') {
    return;
  }

  // Guard against bfcache: Chrome closes the port when a page is cached.
  // Wrap postMessage so stale sends are silently dropped instead of
  // generating "Unchecked runtime.lastError" warnings.
  let _disconnected = false;
  port.onDisconnect.addListener(() => {
    // Consume lastError: Chrome sets it on disconnect (e.g. bfcache).
    // Not reading it here triggers "Unchecked runtime.lastError" warnings.
    void browser.runtime.lastError;
    _disconnected = true;
  });
  const _origPost = port.postMessage.bind(port);
  port.postMessage = (msg) => {
    if (_disconnected) {
      return;
    }
    try {
      _origPost(msg);
    } catch (_e) {
      _disconnected = true;
    }
  };
  port.isDisconnected = () => _disconnected;

  port.onMessage.addListener(async (msg) => {
    if (!_validateMessage(msg)) {
      port.postMessage({ type: 'error', message: 'Invalid message payload.' });
      return;
    }

    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;

    try {
      switch (msg.action) {
        case 'summarize':
          await _handleSummarize(port, tabId, msg);
          break;
        case 'followUp':
          await _handleFollowUp(port, tabId, msg);
          break;
        case 'getStatus':
          await _handleGetStatus(port, tabId);
          break;
        default:
          port.postMessage({ type: 'error', message: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      console.error('[service-worker] Unhandled error:', err);
      port.postMessage({ type: 'error', message: 'An unexpected error occurred.' });
    }
  });
});

// ---------------------------------------------------------------------------
// Tab lifecycle cleanup
// ---------------------------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  conversations.delete(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear conversation when user navigates to a new page
  if (changeInfo.url) {
    conversations.delete(tabId);
  }
});

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

/**
 * Handle the "summarize" action.
 * Validates the article payload, initialises conversation state, and streams a summary.
 *
 * @param {chrome.runtime.Port} port
 * @param {number|null} tabId
 * @param {Object} msg
 */
async function _handleSummarize(port, tabId, msg) {
  const { article } = msg;

  if (!article || typeof article.fullText !== 'string' || !Array.isArray(article.paragraphs)) {
    port.postMessage({ type: 'error', message: 'Invalid article payload.' });
    return;
  }

  const apiKey = await _getApiKey();
  if (!apiKey) {
    port.postMessage({
      type: 'error',
      message: 'No API key found. Please set your OpenAI API key in the extension settings.',
    });
    return;
  }

  const model = (await _getSetting('openai_model')) || DEFAULT_MODEL;

  // Build system prompt with paragraph index
  const systemPrompt = _buildSummarizePrompt(article.paragraphs);

  // Initialise or reset conversation for this tab
  const conversation = {
    tabId,
    url: article.url || '',
    articleText: article.fullText.slice(0, MAX_ARTICLE_CHARS),
    paragraphs: article.paragraphs,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please summarize this article.' },
    ],
  };

  if (tabId !== null) {
    conversations.set(tabId, conversation);
  }

  await _streamCompletion(port, apiKey, model, conversation.messages, tabId);
}

/**
 * Handle the "followUp" action.
 * Appends the user question to the existing conversation and streams a response.
 *
 * @param {chrome.runtime.Port} port
 * @param {number|null} tabId
 * @param {Object} msg
 */
async function _handleFollowUp(port, tabId, msg) {
  if (!msg.question || typeof msg.question !== 'string' || !msg.question.trim()) {
    port.postMessage({ type: 'error', message: 'Question cannot be empty.' });
    return;
  }

  const conversation = tabId !== null ? conversations.get(tabId) : null;
  if (!conversation) {
    port.postMessage({
      type: 'error',
      message: 'No active conversation. Please summarize the article first.',
    });
    return;
  }

  const apiKey = await _getApiKey();
  if (!apiKey) {
    port.postMessage({
      type: 'error',
      message: 'No API key found. Please set your OpenAI API key in the extension settings.',
    });
    return;
  }

  const model = (await _getSetting('openai_model')) || DEFAULT_MODEL;

  // Append user question
  conversation.messages.push({ role: 'user', content: msg.question.trim() });

  // Trim history to keep last N pairs (system + user/assistant alternates)
  _trimHistory(conversation);

  await _streamCompletion(port, apiKey, model, conversation.messages, tabId);
}

/**
 * Handle the "getStatus" action — returns API key presence and conversation state.
 *
 * @param {chrome.runtime.Port} port
 * @param {number|null} tabId
 */
async function _handleGetStatus(port, tabId) {
  const apiKey = await _getApiKey();
  const hasConversation = tabId !== null && conversations.has(tabId);
  port.postMessage({
    type: 'status',
    hasApiKey: Boolean(apiKey),
    hasConversation,
  });
}

// ---------------------------------------------------------------------------
// OpenAI Streaming
// ---------------------------------------------------------------------------

/**
 * Call the OpenAI chat completions API with streaming and forward chunks via port.
 * Handles retries for 429 and 5xx errors with exponential backoff.
 *
 * @param {chrome.runtime.Port} port
 * @param {string} apiKey
 * @param {string} model
 * @param {Message[]} messages
 * @param {number|null} tabId
 * @param {number} [attempt=0]
 */
async function _streamCompletion(port, apiKey, model, messages, tabId, attempt = 0) {
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 1000;

  let response;
  try {
    response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 2048,
      }),
    });
  } catch (_err) {
    port.postMessage({
      type: 'error',
      message: 'Connection failed. Please check your internet connection.',
    });
    return;
  }

  // Handle HTTP-level errors
  if (!response.ok) {
    if (response.status === 401) {
      port.postMessage({
        type: 'error',
        message: 'Invalid API key. Please check your settings.',
      });
      return;
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await _sleep(delay);
      return _streamCompletion(port, apiKey, model, messages, tabId, attempt + 1);
    }

    if (response.status >= 500 && attempt < 1) {
      await _sleep(BACKOFF_BASE_MS);
      return _streamCompletion(port, apiKey, model, messages, tabId, attempt + 1);
    }

    port.postMessage({
      type: 'error',
      message: `OpenAI API error (${response.status}). Please try again.`,
    });
    return;
  }

  // Read the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let assistantContent = '';
  let buffer = '';

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Abort stream if the content-script port was closed (e.g. bfcache)
      if (port.isDisconnected && port.isDisconnected()) {
        reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') {
            // Stream complete — append assistant reply to conversation history
            if (tabId !== null && conversations.has(tabId)) {
              conversations.get(tabId).messages.push({
                role: 'assistant',
                content: assistantContent,
              });
            }
            port.postMessage({ type: 'done' });
          }
          continue;
        }

        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        const jsonStr = trimmed.slice(6);
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (_e) {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          assistantContent += delta;
          port.postMessage({ type: 'chunk', content: delta });
        }
      }
    }
  } catch (err) {
    console.error('[service-worker] Stream read error:', err);
    port.postMessage({ type: 'error', message: 'Stream interrupted. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for article summarization.
 *
 * @param {{ id: string, text: string }[]} paragraphs
 * @returns {string}
 */
function _buildSummarizePrompt(paragraphs) {
  const paragraphIndex = paragraphs.map((p) => `[${p.id}]: ${p.text}`).join('\n');

  return `You are an article summarizer. The user has provided an article from a webpage.

Your job:
1. Provide a clear, structured summary of the article.
2. For every claim or key point, include a reference to the source paragraph using the format [p-N] where N maps to the paragraph index.
3. Keep the summary concise — aim for 3-5 key points.
4. Use markdown formatting (bold for emphasis, bullet lists for points).

ARTICLE PARAGRAPHS:
${paragraphIndex}

RULES:
- Every factual claim MUST have at least one [p-N] reference.
- If information spans multiple paragraphs, cite all relevant ones: [p-2][p-5].
- Do NOT make up information not in the article.
- If the article is too short or not really an article, say so briefly.`;
}

// ---------------------------------------------------------------------------
// Conversation History Management
// ---------------------------------------------------------------------------

/**
 * Trim conversation history to keep only the last N user/assistant pairs.
 * The system message at index 0 is always preserved.
 *
 * @param {Conversation} conversation
 */
function _trimHistory(conversation) {
  const { messages } = conversation;
  const systemMsg = messages[0]; // always preserved
  const rest = messages.slice(1);

  // Keep last MAX_HISTORY_PAIRS * 2 messages (user + assistant alternating)
  const maxMessages = MAX_HISTORY_PAIRS * 2;
  const trimmed = rest.slice(-maxMessages);

  conversation.messages = [systemMsg, ...trimmed];
}

// ---------------------------------------------------------------------------
// Storage Helpers
// ---------------------------------------------------------------------------

/**
 * Read the stored OpenAI API key.
 * @returns {Promise<string|null>}
 */
async function _getApiKey() {
  return _getSetting('openai_api_key');
}

/**
 * Read a value from chrome.storage.local.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function _getSetting(key) {
  return new Promise((resolve) => {
    browser.storage.local.get(key, (result) => {
      resolve(result[key] || null);
    });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Validate that an incoming port message has the expected shape.
 * @param {unknown} msg
 * @returns {boolean}
 */
function _validateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  if (typeof msg.action !== 'string') {
    return false;
  }
  const validActions = ['summarize', 'followUp', 'getStatus'];
  return validActions.includes(msg.action);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
