/**
 * content.js — Content script entry point.
 *
 * Wires together:
 *  - extractor.js  (extractArticle, scrollToReference, getSerializableParagraphs)
 *  - widget.js     (initWidget, registerCallbacks, etc.)
 *  - Background service worker via chrome.runtime.connect port
 *
 * Loaded at document_idle. All functions from extractor.js and widget.js
 * are available in the same content script context.
 */

/* global
  extractArticle, scrollToReference,
  initWidget, registerCallbacks, setParagraphs, setFabDisabled,
  appendUserMessage, startAssistantMessage, appendStreamChunk,
  finaliseAssistantMessage, appendErrorMessage
*/

/** @type {chrome.runtime.Port|null} */
let _port = null;

/** Whether we have a live extractable article */
let _articleAvailable = false;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(function init() {
  // 1. Initialise the widget (FAB only — panel is lazy)
  initWidget();

  // 2. Attempt extraction to know if this page has an article
  const result = extractArticle();
  _articleAvailable = Boolean(result);
  setFabDisabled(!_articleAvailable);

  // 3. Register widget callbacks
  registerCallbacks({
    onSummarize: _handleSummarize,
    onFollowUp: _handleFollowUp,
    onReferenceClick: _handleReferenceClick,
  });

  // 4. Connect to background and check status
  _connectPort();
  _sendToBackground({ action: 'getStatus' });
})();

// ---------------------------------------------------------------------------
// Port management
// ---------------------------------------------------------------------------

/**
 * Open (or re-open) the persistent port to the background service worker.
 */
function _connectPort() {
  if (_port) {
    try {
      _port.disconnect();
    } catch (_e) {
      // Port may already be closed
    }
  }

  _port = browser.runtime.connect({ name: 'summarizer' });

  _port.onMessage.addListener(_onBackgroundMessage);

  _port.onDisconnect.addListener(() => {
    _port = null;
  });
}

/**
 * Send a message to the background, reconnecting if the port is closed.
 * @param {Object} msg
 */
function _sendToBackground(msg) {
  if (!_port) {
    _connectPort();
  }
  try {
    _port.postMessage(msg);
  } catch (err) {
    console.error('[content] Failed to send message to background:', err);
    appendErrorMessage('Connection to extension background lost. Please reload the page.');
  }
}

// ---------------------------------------------------------------------------
// Background message handler
// ---------------------------------------------------------------------------

/**
 * Handle messages from the background service worker.
 * @param {{ type: string, content?: string, message?: string, hasApiKey?: boolean, hasConversation?: boolean }} msg
 */
function _onBackgroundMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  switch (msg.type) {
    case 'chunk':
      if (typeof msg.content === 'string') {
        appendStreamChunk(msg.content);
      }
      break;

    case 'done':
      finaliseAssistantMessage();
      break;

    case 'error':
      appendErrorMessage(msg.message || 'An error occurred.');
      break;

    case 'status':
      _handleStatusResponse(msg);
      break;

    default:
      console.warn('[content] Unknown message type from background:', msg.type);
  }
}

/**
 * Handle the getStatus response to restore UI state on load.
 * @param {{ hasApiKey: boolean, hasConversation: boolean }} msg
 */
function _handleStatusResponse(msg) {
  if (!msg.hasApiKey) {
    // Prompt user to set their key — shown as a one-time error bubble
    // only when panel is first opened; we do nothing here to avoid spam
  }
  // If there's an existing conversation (e.g. after service worker restart),
  // the conversation is in-memory in the background and still accessible.
  // Nothing further needed here for MVP.
}

// ---------------------------------------------------------------------------
// User action handlers
// ---------------------------------------------------------------------------

/**
 * Called when user clicks the "Summarize" button.
 */
function _handleSummarize() {
  if (!_articleAvailable) {
    appendErrorMessage("Couldn't extract an article from this page. Try on a news article or blog post.");
    return;
  }

  const article = extractArticle();
  if (!article) {
    appendErrorMessage("Couldn't extract article content. The page may be behind a paywall or dynamically loaded.");
    return;
  }

  // Update paragraph index for chip tooltips
  setParagraphs(article.paragraphs);

  // Show user intent message
  appendUserMessage('Summarize this article');

  // Start streaming AI response
  startAssistantMessage();

  // Dispatch to background
  _sendToBackground({ action: 'summarize', article });
}

/**
 * Called when user submits a follow-up question.
 * @param {string} question
 */
function _handleFollowUp(question) {
  appendUserMessage(question);
  startAssistantMessage();
  _sendToBackground({ action: 'followUp', question });
}

/**
 * Called when user clicks a reference chip.
 * @param {string} refId - e.g. "p-3"
 */
function _handleReferenceClick(refId) {
  scrollToReference(refId);
}
