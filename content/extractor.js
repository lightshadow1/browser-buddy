/**
 * extractor.js — Article extraction and paragraph indexing.
 *
 * Responsibilities:
 *  - Parse the current page with Mozilla Readability
 *  - Build a sequential indexed list of block-level paragraphs
 *  - Provide scroll-to and highlight behaviour for reference navigation
 *
 * Depends on: lib/readability.js (loaded before this file via manifest)
 */

/* global Readability */
/* exported extractArticle, scrollToReference, getParagraphById, getSerializableParagraphs */
/* eslint-disable no-unused-vars */

/** Maximum article character count sent to the API (~12k tokens @ 4 chars/token). */
const MAX_ARTICLE_CHARS = 48000;

/** CSS class toggled for paragraph highlight animation. */
const HIGHLIGHT_CLASS = 'article-summarizer-highlight';

/** Duration of the highlight animation in ms. */
const HIGHLIGHT_DURATION_MS = 2000;

/**
 * @typedef {Object} IndexedParagraph
 * @property {string} id          - Sequential ID e.g. "p-0", "p-1"
 * @property {string} text        - Plain text content
 * @property {Element} element    - Reference to the original DOM node
 * @property {number} charStart   - Character offset in the full article text
 * @property {number} charEnd     - Character offset end
 */

/**
 * @typedef {Object} ExtractionResult
 * @property {string} title
 * @property {string|null} byline
 * @property {string|null} siteName
 * @property {string} url
 * @property {string} fullText                - Concatenated plain text (may be truncated)
 * @property {boolean} truncated              - Whether fullText was capped
 * @property {IndexedParagraph[]} paragraphs  - Indexed paragraphs
 * @property {string} extractedAt             - ISO timestamp
 */

/**
 * Block-level element tags to index as paragraphs.
 * @type {Set<string>}
 */
const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * In-memory index of paragraphs for the current extraction.
 * Keyed by paragraph ID.
 * @type {Map<string, IndexedParagraph>}
 */
let _paragraphIndex = new Map();

/**
 * Extract the article from the current page using Mozilla Readability.
 *
 * @returns {ExtractionResult|null} Null if Readability fails or page is not an article.
 */
function extractArticle() {
  if (typeof Readability === 'undefined') {
    console.error('[extractor] Readability is not loaded.');
    return null;
  }

  // Clone the document — Readability mutates the DOM it receives.
  const docClone = document.cloneNode(true);

  let article;
  try {
    const reader = new Readability(docClone);
    article = reader.parse();
  } catch (err) {
    console.error('[extractor] Readability parse error:', err);
    return null;
  }

  if (!article || !article.content) {
    return null;
  }

  // Build a temporary DOM from the parsed HTML to walk block elements.
  const container = document.createElement('div');
  container.innerHTML = article.content;

  const { paragraphs, fullText, truncated } = _buildParagraphIndex(container);

  _paragraphIndex = new Map(paragraphs.map((p) => [p.id, p]));

  return {
    title: article.title || document.title || '',
    byline: article.byline || null,
    siteName: article.siteName || null,
    url: window.location.href,
    fullText,
    truncated,
    paragraphs: paragraphs.map(({ id, text, charStart, charEnd }) => ({
      id,
      text,
      charStart,
      charEnd,
    })),
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Walk a container element, indexing all block-level nodes as paragraphs.
 * Also builds the concatenated fullText with truncation enforcement.
 *
 * @param {Element} container
 * @returns {{ paragraphs: IndexedParagraph[], fullText: string, truncated: boolean }}
 */
function _buildParagraphIndex(container) {
  const paragraphs = [];
  let charOffset = 0;
  let truncated = false;
  const textParts = [];

  const blockNodes = _collectBlockNodes(container);

  for (const node of blockNodes) {
    const text = (node.textContent || '').trim();
    if (!text) {
      continue;
    }

    const id = `p-${paragraphs.length}`;
    const charStart = charOffset;
    const charEnd = charOffset + text.length;

    // Find the matching original DOM element by walking the live document.
    // We match by tag + trimmed text content (best-effort; good enough for MVP).
    const liveElement = _findLiveElement(node.tagName, text) || node;

    paragraphs.push({ id, text, element: liveElement, charStart, charEnd });
    textParts.push(`[${id}]: ${text}`);
    charOffset = charEnd + 1;

    // Enforce token budget
    const currentLength = textParts.reduce((sum, t) => sum + t.length + 1, 0);
    if (currentLength >= MAX_ARTICLE_CHARS) {
      truncated = true;
      break;
    }
  }

  let fullText = textParts.join('\n');
  if (truncated) {
    fullText += '\n\n[Note: Article was truncated to fit within the context limit.]';
  }

  return { paragraphs, fullText, truncated };
}

/**
 * Collect all direct block-level descendant nodes from a container, in document order.
 *
 * @param {Element} container
 * @returns {Element[]}
 */
function _collectBlockNodes(container) {
  const results = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (BLOCK_TAGS.has(node.tagName)) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    results.push(node);
  }
  return results;
}

/**
 * Attempt to find the live DOM element that matches the given tag and text.
 * Used to store references to original page elements for scroll-to.
 *
 * @param {string} tagName
 * @param {string} text
 * @returns {Element|null}
 */
function _findLiveElement(tagName, text) {
  const candidates = document.getElementsByTagName(tagName);
  for (const el of candidates) {
    if ((el.textContent || '').trim() === text) {
      return el;
    }
  }
  return null;
}

/**
 * Scroll the page to the paragraph with the given ID and apply a temporary highlight.
 *
 * @param {string} paragraphId - e.g. "p-3"
 * @returns {boolean} Whether the paragraph was found and scrolled to.
 */
function scrollToReference(paragraphId) {
  const paragraph = _paragraphIndex.get(paragraphId);
  if (!paragraph || !paragraph.element) {
    return false;
  }

  const el = paragraph.element;

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Apply highlight (CSS class toggled; animation defined in widget.css injected style)
  _applyHighlight(el);

  return true;
}

/**
 * Apply the highlight animation to a DOM element.
 *
 * @param {Element} el
 */
function _applyHighlight(el) {
  // Inject the highlight style into the page head if not already present
  if (!document.getElementById('article-summarizer-highlight-style')) {
    const style = document.createElement('style');
    style.id = 'article-summarizer-highlight-style';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    style.textContent = reducedMotion
      ? `.${HIGHLIGHT_CLASS} { outline: 3px solid #4f46e5; outline-offset: 2px; }`
      : `
        @keyframes as-highlight-fade {
          0%   { background-color: rgba(79, 70, 229, 0.3); outline: 3px solid #4f46e5; }
          100% { background-color: transparent; outline: 3px solid transparent; }
        }
        .${HIGHLIGHT_CLASS} {
          animation: as-highlight-fade ${HIGHLIGHT_DURATION_MS}ms ease-out forwards;
          outline-offset: 2px;
          border-radius: 3px;
        }
      `;
    document.head.appendChild(style);
  }

  el.classList.remove(HIGHLIGHT_CLASS);
  // Force reflow so the animation restarts if called multiple times
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);

  setTimeout(() => {
    el.classList.remove(HIGHLIGHT_CLASS);
  }, HIGHLIGHT_DURATION_MS + 100);
}

/**
 * Retrieve an indexed paragraph by ID from the current extraction.
 *
 * @param {string} id - e.g. "p-0"
 * @returns {IndexedParagraph|null}
 */
function getParagraphById(id) {
  return _paragraphIndex.get(id) || null;
}

/**
 * Returns a serialisable snapshot of the current paragraph index
 * (without DOM element references, safe to send via chrome.runtime.sendMessage).
 *
 * @returns {{ id: string, text: string }[]}
 */
function getSerializableParagraphs() {
  return Array.from(_paragraphIndex.values()).map(({ id, text }) => ({ id, text }));
}

// Expose API
/* eslint-disable no-unused-vars */
// These are consumed by content.js loaded in the same content script context.
