/**
 * widget.js — Floating chat widget rendered inside a shadow DOM.
 *
 * Responsibilities:
 *  - Create and manage the shadow-DOM-isolated widget
 *  - Render streamed AI responses token-by-token
 *  - Parse [p-N] references and render as interactive chips
 *  - Handle all UI interactions: FAB, panel, drag, keyboard
 *  - Expose a callback API consumed by content.js
 *
 * Depends on: lib/marked.min.js, lib/dompurify.min.js (loaded before this file)
 */

/* global marked, DOMPurify */
/* exported initWidget, setFabDisabled, appendUserMessage, startAssistantMessage,
   appendStreamChunk, finaliseAssistantMessage, appendErrorMessage,
   registerCallbacks, setParagraphs, openPanel */
/* eslint-disable no-unused-vars */

// ---------------------------------------------------------------------------
// DOMPurify sanitization config — strict allowlist
// ---------------------------------------------------------------------------
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'p', 'code', 'span', 'br'],
  ALLOWED_ATTR: ['class', 'data-ref', 'data-tooltip', 'tabindex', 'role', 'aria-label'],
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {ShadowRoot|null} */
let _shadowRoot = null;

/** @type {HTMLElement|null} The FAB button */
let _fab = null;

/** @type {HTMLElement|null} The chat panel */
let _panel = null;

/** @type {HTMLElement|null} The messages container */
let _messagesEl = null;

/** @type {HTMLTextAreaElement|null} */
let _inputEl = null;

/** @type {HTMLButtonElement|null} */
let _summarizeBtn = null;

/** @type {HTMLButtonElement|null} */
let _sendBtn = null;

/** Whether a streaming response is currently in progress */
let _isStreaming = false;

/** Whether the panel has been initialised (lazy) */
let _panelInitialised = false;

/** Current streaming AI bubble element */
let _streamingBubble = null;

/** Raw text buffer for the current streaming AI response */
let _streamBuffer = '';

/** Callback registry */
const _callbacks = {
  /** @type {Function|null} Called when user clicks Summarize */
  onSummarize: null,
  /** @type {Function|null} Called when user submits a follow-up question */
  onFollowUp: null,
  /** @type {Function|null} Called when user clicks a reference chip */
  onReferenceClick: null,
};

/** Stored paragraph index for tooltip text (set after extraction) */
let _paragraphs = [];

// Drag state
let _dragging = false;
let _dragOffsetX = 0;
let _dragOffsetY = 0;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the widget. Creates the shadow host, FAB, and lazy panel.
 * Must be called once from content.js.
 */
function initWidget() {
  if (_shadowRoot) {
    return; // Already initialised
  }

  // Create shadow host
  const host = document.createElement('div');
  host.id = 'article-summarizer-host';
  host.setAttribute('data-extension', 'article-summarizer');
  document.body.appendChild(host);

  _shadowRoot = host.attachShadow({ mode: 'open' });

  // Inject CSS into shadow root
  _injectStyles();

  // Render FAB only (panel is lazy)
  _renderFab();
}

/**
 * Inject the widget CSS into the shadow root from the extension URL.
 */
function _injectStyles() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = browser.runtime.getURL('content/widget.css');
  _shadowRoot.appendChild(link);
}

// ---------------------------------------------------------------------------
// FAB
// ---------------------------------------------------------------------------

function _renderFab() {
  _fab = document.createElement('button');
  _fab.id = 'as-fab';
  _fab.setAttribute('aria-label', 'Article Summarizer — open chat panel');
  _fab.setAttribute('title', 'Article Summarizer');
  _fab.textContent = '💬';

  _fab.addEventListener('click', _togglePanel);
  _fab.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      _togglePanel();
    }
  });

  _shadowRoot.appendChild(_fab);
}

/**
 * Mark the FAB as disabled (no extractable article on this page).
 * @param {boolean} disabled
 */
function setFabDisabled(disabled) {
  if (!_fab) {
    return;
  }
  if (disabled) {
    _fab.classList.add('disabled');
    _fab.setAttribute('aria-label', 'Article Summarizer — no article detected on this page');
    _fab.setAttribute('title', 'No article detected on this page');
  } else {
    _fab.classList.remove('disabled');
    _fab.setAttribute('aria-label', 'Article Summarizer — open chat panel');
    _fab.setAttribute('title', 'Article Summarizer');
  }
}

// ---------------------------------------------------------------------------
// Panel (lazy initialised)
// ---------------------------------------------------------------------------

function _ensurePanelInitialised() {
  if (_panelInitialised) {
    return;
  }
  _panelInitialised = true;
  _renderPanel();
}

function _renderPanel() {
  _panel = document.createElement('div');
  _panel.id = 'as-panel';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-label', 'Article Summarizer chat panel');
  _panel.setAttribute('aria-modal', 'false');
  _panel.setAttribute('hidden', '');

  _panel.innerHTML = `
    <div id="as-header" role="toolbar" aria-label="Panel controls">
      <span id="as-title">✨ Article Summarizer</span>
      <div class="as-header-actions">
        <button class="as-icon-btn" id="as-minimize-btn" aria-label="Minimize panel" title="Minimize">−</button>
        <button class="as-icon-btn" id="as-close-btn"    aria-label="Close panel"    title="Close">✕</button>
      </div>
    </div>
    <div id="as-messages" role="log" aria-live="polite" aria-label="Chat messages" aria-relevant="additions"></div>
    <div id="as-input-bar" role="group" aria-label="Message input">
      <button id="as-summarize-btn" aria-label="Summarize this article">Summarize</button>
      <textarea
        id="as-input"
        rows="1"
        placeholder="Ask a question…"
        aria-label="Follow-up question input"
        aria-multiline="true"
      ></textarea>
      <button id="as-send-btn" aria-label="Send message">➤</button>
    </div>
  `;

  _shadowRoot.appendChild(_panel);

  // Cache references
  _messagesEl = _panel.querySelector('#as-messages');
  _inputEl = _panel.querySelector('#as-input');
  _summarizeBtn = _panel.querySelector('#as-summarize-btn');
  _sendBtn = _panel.querySelector('#as-send-btn');

  // Wire events
  _summarizeBtn.addEventListener('click', _onSummarizeClick);
  _sendBtn.addEventListener('click', _onSendClick);
  _inputEl.addEventListener('keydown', _onInputKeydown);
  _inputEl.addEventListener('input', _onInputResize);

  _panel.querySelector('#as-minimize-btn').addEventListener('click', _closePanel);
  _panel.querySelector('#as-close-btn').addEventListener('click', _closePanel);

  // Drag
  _panel.querySelector('#as-header').addEventListener('mousedown', _onDragStart);

  // Panel-level keyboard handling
  _panel.addEventListener('keydown', _onPanelKeydown);
}

// ---------------------------------------------------------------------------
// Panel open/close
// ---------------------------------------------------------------------------

function _togglePanel() {
  _ensurePanelInitialised();
  if (_panel.hasAttribute('hidden')) {
    _openPanel();
  } else {
    _closePanel();
  }
}

function _openPanel() {
  _panel.removeAttribute('hidden');
  _fab.setAttribute('aria-expanded', 'true');
  // Move focus to the input for accessibility
  requestAnimationFrame(() => {
    if (_inputEl) {
      _inputEl.focus();
    }
  });
}

function _closePanel() {
  if (!_panel) {
    return;
  }
  _panel.setAttribute('hidden', '');
  _fab.setAttribute('aria-expanded', 'false');
  _fab.focus();
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function _onSummarizeClick() {
  if (_isStreaming) {
    return;
  }
  if (_callbacks.onSummarize) {
    _callbacks.onSummarize();
  }
}

function _onSendClick() {
  _submitQuestion();
}

function _onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    _submitQuestion();
  }
}

function _onInputResize() {
  _inputEl.style.height = 'auto';
  _inputEl.style.height = Math.min(_inputEl.scrollHeight, 80) + 'px';
}

function _submitQuestion() {
  if (_isStreaming || !_inputEl) {
    return;
  }
  const question = _inputEl.value.trim();
  if (!question) {
    return;
  }
  _inputEl.value = '';
  _inputEl.style.height = '';
  if (_callbacks.onFollowUp) {
    _callbacks.onFollowUp(question);
  }
}

function _onPanelKeydown(e) {
  if (e.key === 'Escape') {
    _closePanel();
  }
}

// ---------------------------------------------------------------------------
// Drag behaviour
// ---------------------------------------------------------------------------

function _onDragStart(e) {
  // Only drag on the header background, not on buttons
  if (e.target.closest('.as-icon-btn')) {
    return;
  }
  _dragging = true;
  const rect = _panel.getBoundingClientRect();
  _dragOffsetX = e.clientX - rect.left;
  _dragOffsetY = e.clientY - rect.top;

  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup', _onDragEnd);
}

function _onDragMove(e) {
  if (!_dragging || !_panel) {
    return;
  }
  const x = e.clientX - _dragOffsetX;
  const y = e.clientY - _dragOffsetY;

  // Clamp to viewport
  const maxX = window.innerWidth - _panel.offsetWidth;
  const maxY = window.innerHeight - _panel.offsetHeight;

  _panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  _panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  _panel.style.right = 'auto';
  _panel.style.bottom = 'auto';
}

function _onDragEnd() {
  _dragging = false;
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup', _onDragEnd);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

/**
 * Append a user message bubble to the chat.
 * @param {string} text
 */
function appendUserMessage(text) {
  _ensurePanelInitialised();
  const wrapper = document.createElement('div');
  wrapper.className = 'as-message user';

  const bubble = document.createElement('div');
  bubble.className = 'as-bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  _messagesEl.appendChild(wrapper);
  _scrollToBottom();
}

/**
 * Start a new streaming AI message. Returns the bubble element for streaming into.
 * @returns {HTMLElement}
 */
function startAssistantMessage() {
  _ensurePanelInitialised();
  _streamBuffer = '';
  _isStreaming = true;
  _setInputsDisabled(true);

  const wrapper = document.createElement('div');
  wrapper.className = 'as-message assistant';
  wrapper.setAttribute('aria-live', 'off'); // parent #as-messages handles live

  // Typing indicator
  const typing = document.createElement('div');
  typing.className = 'as-typing';
  typing.setAttribute('aria-label', 'Loading');
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('div');
    dot.className = 'as-typing-dot';
    typing.appendChild(dot);
  }

  wrapper.appendChild(typing);
  _messagesEl.appendChild(wrapper);
  _scrollToBottom();

  _streamingBubble = { wrapper, typing };
  return wrapper;
}

/**
 * Append a streaming chunk to the current AI message.
 * Handles SSE boundary edge cases: buffers incomplete [p-N] references.
 *
 * @param {string} chunk - The delta text from the SSE stream
 */
function appendStreamChunk(chunk) {
  if (!_streamingBubble) {
    return;
  }

  _streamBuffer += chunk;

  // Remove typing indicator once first chunk arrives
  if (_streamingBubble.typing && _streamingBubble.typing.parentNode) {
    _streamingBubble.typing.remove();
    _streamingBubble.typing = null;

    // Add bubble element
    const bubble = document.createElement('div');
    bubble.className = 'as-bubble';
    _streamingBubble.wrapper.appendChild(bubble);
    _streamingBubble.bubble = bubble;
  }

  // Re-render the full buffer, but only if there are no partial [p- tokens
  // to avoid rendering a half-formed reference chip
  if (_isSafeToRender(_streamBuffer)) {
    _renderMarkdownWithRefs(_streamingBubble.bubble, _streamBuffer);
  } else {
    // Render text up to the last safe point (before potential partial ref)
    const safeText = _streamBuffer.replace(/\[p-\d*$/, '');
    _renderMarkdownWithRefs(_streamingBubble.bubble, safeText);
  }

  _scrollToBottom();
}

/**
 * Finalise the streaming message — render the complete buffer.
 */
function finaliseAssistantMessage() {
  if (_streamingBubble) {
    if (_streamingBubble.typing && _streamingBubble.typing.parentNode) {
      _streamingBubble.typing.remove();
      const bubble = document.createElement('div');
      bubble.className = 'as-bubble';
      _streamingBubble.wrapper.appendChild(bubble);
      _streamingBubble.bubble = bubble;
    }
    if (_streamingBubble.bubble) {
      _renderMarkdownWithRefs(_streamingBubble.bubble, _streamBuffer);
    }
    _streamingBubble = null;
  }

  _streamBuffer = '';
  _isStreaming = false;
  _setInputsDisabled(false);
  _scrollToBottom();

  requestAnimationFrame(() => {
    if (_inputEl) {
      _inputEl.focus();
    }
  });
}

/**
 * Append an error message bubble.
 * @param {string} message
 */
function appendErrorMessage(message) {
  _ensurePanelInitialised();

  // Clean up any pending streaming state
  if (_streamingBubble) {
    _streamingBubble = null;
    _streamBuffer = '';
    _isStreaming = false;
    _setInputsDisabled(false);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'as-message error';

  const bubble = document.createElement('div');
  bubble.className = 'as-bubble';
  bubble.setAttribute('role', 'alert');
  bubble.textContent = message;

  wrapper.appendChild(bubble);
  _messagesEl.appendChild(wrapper);
  _scrollToBottom();
}

// ---------------------------------------------------------------------------
// Markdown + reference rendering
// ---------------------------------------------------------------------------

/**
 * Render markdown text (possibly containing [p-N] refs) into a bubble element.
 * Uses marked.js for markdown parsing and DOMPurify for sanitization.
 *
 * @param {HTMLElement} bubble
 * @param {string} text
 */
function _renderMarkdownWithRefs(bubble, text) {
  if (!text) {
    return;
  }

  // Replace [p-N] references with a safe placeholder before markdown parsing
  // so marked doesn't mangle the brackets
  const REF_PLACEHOLDER = '\x00REF\x00';
  const refs = [];
  const withPlaceholders = text.replace(/\[p-(\d+)\]/g, (_match, n) => {
    refs.push(`p-${n}`);
    return `${REF_PLACEHOLDER}${refs.length - 1}${REF_PLACEHOLDER}`;
  });

  // Parse markdown
  let html;
  if (typeof marked !== 'undefined') {
    html = marked.parse(withPlaceholders, { breaks: true, gfm: true });
  } else {
    // Fallback: minimal inline markdown
    html = _simpleMarkdown(withPlaceholders);
  }

  // Sanitize
  if (typeof DOMPurify !== 'undefined') {
    html = DOMPurify.sanitize(html, SANITIZE_CONFIG);
  }

  // Set HTML
  bubble.innerHTML = html;

  // Replace placeholders with interactive chip elements
  _replacePlaceholdersWithChips(bubble, refs);
}

/**
 * Walk the bubble DOM tree and replace ref placeholders with chip spans.
 *
 * @param {HTMLElement} root
 * @param {string[]} refs  - Ordered list of paragraph IDs for each placeholder
 */
function _replacePlaceholdersWithChips(root, refs) {
  const REF_PLACEHOLDER = '\x00REF\x00';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const content = textNode.textContent;
    if (!content.includes(REF_PLACEHOLDER)) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    const parts = content.split(new RegExp(`${REF_PLACEHOLDER}(\\d+)${REF_PLACEHOLDER}`));

    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Plain text
        if (parts[i]) {
          fragment.appendChild(document.createTextNode(parts[i]));
        }
      } else {
        // Ref index
        const refIdx = parseInt(parts[i], 10);
        const refId = refs[refIdx];
        if (refId !== undefined) {
          fragment.appendChild(_createRefChip(refId));
        }
      }
    }

    textNode.parentNode.replaceChild(fragment, textNode);
  }
}

/**
 * Create a clickable reference chip element.
 *
 * @param {string} refId  - e.g. "p-3"
 * @returns {HTMLElement}
 */
function _createRefChip(refId) {
  const chip = document.createElement('span');
  chip.className = 'ref-chip';
  chip.setAttribute('data-ref', refId);
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('role', 'button');

  // Display as [N] where N is the numeric part
  const num = refId.replace('p-', '');
  chip.textContent = `[${num}]`;
  chip.setAttribute('aria-label', `Reference ${num} — click to jump to source paragraph`);

  // Tooltip: first 100 chars of the paragraph
  const para = _paragraphs.find((p) => p.id === refId);
  if (para) {
    const preview = para.text.slice(0, 100) + (para.text.length > 100 ? '…' : '');
    chip.setAttribute('data-tooltip', preview);
  }

  chip.addEventListener('click', () => {
    if (_callbacks.onReferenceClick) {
      _callbacks.onReferenceClick(refId);
    }
  });

  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (_callbacks.onReferenceClick) {
        _callbacks.onReferenceClick(refId);
      }
    }
  });

  return chip;
}

/**
 * Check whether the current buffer is safe to fully render
 * (i.e. doesn't end mid-way through a [p-N] token).
 *
 * @param {string} text
 * @returns {boolean}
 */
function _isSafeToRender(text) {
  // Unsafe if the text ends with a partial [p-... that hasn't closed yet
  return !/\[p-\d*$/.test(text);
}

/**
 * Minimal markdown fallback if marked.js is unavailable.
 * @param {string} text
 * @returns {string}
 */
function _simpleMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _scrollToBottom() {
  if (_messagesEl) {
    _messagesEl.scrollTop = _messagesEl.scrollHeight;
  }
}

function _setInputsDisabled(disabled) {
  if (_inputEl) {
    _inputEl.disabled = disabled;
  }
  if (_sendBtn) {
    _sendBtn.disabled = disabled;
  }
  if (_summarizeBtn) {
    _summarizeBtn.disabled = disabled;
  }
}

// ---------------------------------------------------------------------------
// Public API consumed by content.js
// ---------------------------------------------------------------------------

/**
 * Register event callbacks.
 * @param {{ onSummarize?: Function, onFollowUp?: Function, onReferenceClick?: Function }} cbs
 */
function registerCallbacks(cbs) {
  if (cbs.onSummarize) {
    _callbacks.onSummarize = cbs.onSummarize;
  }
  if (cbs.onFollowUp) {
    _callbacks.onFollowUp = cbs.onFollowUp;
  }
  if (cbs.onReferenceClick) {
    _callbacks.onReferenceClick = cbs.onReferenceClick;
  }
}

/**
 * Update the paragraph index used for chip tooltips.
 * @param {{ id: string, text: string }[]} paragraphs
 */
function setParagraphs(paragraphs) {
  _paragraphs = paragraphs || [];
}

/**
 * Open the panel programmatically.
 */
function openPanel() {
  _ensurePanelInitialised();
  _openPanel();
}

// Expose public surface
/* eslint-disable no-unused-vars */
// These symbols are accessed by content.js in the same content script context.
