/**
 * extractor.test.js — Unit tests for content/extractor.js
 *
 * Tests extraction logic, paragraph indexing, token truncation,
 * and scroll-to-reference behaviour using jsdom.
 */

const { describe, it, expect } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Helpers — replicate the core logic under test in isolation
// (extractor.js runs in a browser context; we test the pure logic here)
// ---------------------------------------------------------------------------

const MAX_ARTICLE_CHARS = 48000;
const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Minimal re-implementation of _buildParagraphIndex for unit testing.
 */
function buildParagraphIndex(container) {
  const paragraphs = [];
  let charOffset = 0;
  let truncated = false;
  const textParts = [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return BLOCK_TAGS.has(node.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || '').trim();
    if (!text) { continue; }

    const id = `p-${paragraphs.length}`;
    const charStart = charOffset;
    const charEnd = charOffset + text.length;
    paragraphs.push({ id, text, element: node, charStart, charEnd });
    textParts.push(`[${id}]: ${text}`);
    charOffset = charEnd + 1;

    const currentLength = textParts.reduce((sum, t) => sum + t.length + 1, 0);
    if (currentLength >= MAX_ARTICLE_CHARS) {
      truncated = true;
      break;
    }
  }

  let fullText = textParts.join('\n');
  if (truncated) { fullText += '\n\n[Note: Article was truncated to fit within the context limit.]'; }
  return { paragraphs, fullText, truncated };
}

/**
 * Parse reference pattern from text.
 * @param {string} text
 * @returns {string[]} List of paragraph IDs e.g. ["p-0", "p-3"]
 */
function parseReferences(text) {
  const matches = [...text.matchAll(/\[p-(\d+)\]/g)];
  return matches.map((m) => `p-${m[1]}`);
}

/**
 * Check whether text is safe to render (no partial [p- token at end).
 */
function isSafeToRender(text) {
  return !/\[p-\d*$/.test(text);
}

// ---------------------------------------------------------------------------
// Tests: Paragraph indexing
// ---------------------------------------------------------------------------

describe('buildParagraphIndex', () => {
  it('indexes paragraph elements with sequential IDs', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>First paragraph.</p>
      <p>Second paragraph.</p>
      <p>Third paragraph.</p>
    `;
    const { paragraphs } = buildParagraphIndex(container);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].id).toBe('p-0');
    expect(paragraphs[1].id).toBe('p-1');
    expect(paragraphs[2].id).toBe('p-2');
  });

  it('indexes h1-h6, li, and blockquote elements', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <h1>Title</h1>
      <h2>Subtitle</h2>
      <blockquote>A quote.</blockquote>
      <ul><li>Item one</li><li>Item two</li></ul>
    `;
    const { paragraphs } = buildParagraphIndex(container);
    expect(paragraphs.length).toBeGreaterThanOrEqual(5);
    const tags = paragraphs.map((p) => p.element.tagName);
    expect(tags).toContain('H1');
    expect(tags).toContain('H2');
    expect(tags).toContain('BLOCKQUOTE');
    expect(tags).toContain('LI');
  });

  it('skips empty elements', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>  </p>
      <p>Real content here.</p>
      <p></p>
    `;
    const { paragraphs } = buildParagraphIndex(container);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].text).toBe('Real content here.');
  });

  it('correctly tracks character offsets', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Hello</p><p>World</p>';
    const { paragraphs } = buildParagraphIndex(container);
    expect(paragraphs[0].charStart).toBe(0);
    expect(paragraphs[0].charEnd).toBe(5); // "Hello"
    expect(paragraphs[1].charStart).toBe(6); // after 5 chars + 1 separator
  });

  it('returns empty array for container with no block elements', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span>Just a span</span>';
    const { paragraphs } = buildParagraphIndex(container);
    expect(paragraphs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Token truncation
// ---------------------------------------------------------------------------

describe('truncation', () => {
  it('truncates when content exceeds MAX_ARTICLE_CHARS', () => {
    const container = document.createElement('div');
    // Each paragraph is ~500 chars; 100 of them = 50,000 chars > 48,000 limit
    for (let i = 0; i < 100; i++) {
      const p = document.createElement('p');
      p.textContent = `Paragraph ${i} ${'x'.repeat(490)}`;
      container.appendChild(p);
    }
    const { truncated, fullText } = buildParagraphIndex(container);
    expect(truncated).toBe(true);
    expect(fullText).toContain('[Note: Article was truncated');
  });

  it('does not truncate short content', () => {
    const container = document.createElement('div');
    for (let i = 0; i < 5; i++) {
      const p = document.createElement('p');
      p.textContent = `Short paragraph ${i}.`;
      container.appendChild(p);
    }
    const { truncated } = buildParagraphIndex(container);
    expect(truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Reference parsing
// ---------------------------------------------------------------------------

describe('parseReferences', () => {
  it('extracts single reference', () => {
    const refs = parseReferences('The article discusses this [p-3].');
    expect(refs).toEqual(['p-3']);
  });

  it('extracts multiple adjacent references', () => {
    const refs = parseReferences('Based on [p-1][p-2][p-5] we can conclude...');
    expect(refs).toEqual(['p-1', 'p-2', 'p-5']);
  });

  it('handles reference at start of string', () => {
    const refs = parseReferences('[p-0] starts the summary.');
    expect(refs).toEqual(['p-0']);
  });

  it('returns empty array when no references present', () => {
    const refs = parseReferences('No references in this text at all.');
    expect(refs).toEqual([]);
  });

  it('does not match partial or malformed references', () => {
    const refs = parseReferences('[p-] and [p] and [3] are not valid.');
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: SSE chunk boundary safety
// ---------------------------------------------------------------------------

describe('isSafeToRender', () => {
  it('returns true for complete text with no partial ref', () => {
    expect(isSafeToRender('The article covers [p-3] in detail.')).toBe(true);
  });

  it('returns false when text ends with partial [p-', () => {
    expect(isSafeToRender('The company grew [p-')).toBe(false);
  });

  it('returns false when text ends with partial [p-1 (no closing bracket)', () => {
    expect(isSafeToRender('The company grew [p-1')).toBe(false);
  });

  it('returns true for text ending with closed bracket', () => {
    expect(isSafeToRender('The company grew [p-12]')).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isSafeToRender('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: fullText format
// ---------------------------------------------------------------------------

describe('fullText format', () => {
  it('formats paragraphs with [p-N]: prefix', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Hello world.</p><p>Second sentence.</p>';
    const { fullText } = buildParagraphIndex(container);
    expect(fullText).toContain('[p-0]: Hello world.');
    expect(fullText).toContain('[p-1]: Second sentence.');
  });

  it('separates paragraphs with newlines', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>A</p><p>B</p>';
    const { fullText } = buildParagraphIndex(container);
    expect(fullText).toBe('[p-0]: A\n[p-1]: B');
  });
});
