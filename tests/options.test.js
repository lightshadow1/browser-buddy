/**
 * options.test.js — Unit tests for the _setStatus helper in options/options.js.
 *
 * The function cannot be imported directly (browser script, no exports), so we
 * replicate its logic here exactly — as done for extractor.test.js — and verify
 * the security-critical properties:
 *   • type is validated against an allowlist (no arbitrary class injection)
 *   • message is set via textContent (no innerHTML / XSS vector)
 */

const { describe, it, expect } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Re-implementation of the logic under test (mirrors options.js _setStatus)
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(['loading', 'success', 'error']);

/**
 * @param {HTMLElement} statusEl
 * @param {'loading'|'success'|'error'} type
 * @param {string} message
 */
function setStatus(statusEl, type, message) {
  statusEl.className = `status ${VALID_TYPES.has(type) ? type : 'error'}`;
  statusEl.textContent = message;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusEl() {
  const el = document.createElement('div');
  el.id = 'api-key-status';
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_setStatus — className', () => {
  let el;
  beforeEach(() => {
    el = makeStatusEl();
  });
  afterEach(() => {
    document.body.removeChild(el);
  });

  it('sets class "status loading" for loading type', () => {
    setStatus(el, 'loading', 'Validating key…');
    expect(el.className).toBe('status loading');
  });

  it('sets class "status success" for success type', () => {
    setStatus(el, 'success', 'Settings saved successfully.');
    expect(el.className).toBe('status success');
  });

  it('sets class "status error" for error type', () => {
    setStatus(el, 'error', 'Please enter an API key.');
    expect(el.className).toBe('status error');
  });

  it('falls back to "status error" for unknown type', () => {
    setStatus(el, 'unknown', 'Some message.');
    expect(el.className).toBe('status error');
  });

  it('falls back to "status error" for empty string type', () => {
    setStatus(el, '', 'Some message.');
    expect(el.className).toBe('status error');
  });

  it('falls back to "status error" for injected class string', () => {
    setStatus(el, 'error" onclick="alert(1)" x="', 'Some message.');
    expect(el.className).toBe('status error');
  });
});

describe('_setStatus — textContent (XSS safety)', () => {
  let el;
  beforeEach(() => {
    el = makeStatusEl();
  });
  afterEach(() => {
    document.body.removeChild(el);
  });

  it('sets textContent to the message string', () => {
    setStatus(el, 'success', 'Settings saved successfully.');
    expect(el.textContent).toBe('Settings saved successfully.');
  });

  it('does NOT interpret HTML tags — angle brackets appear as literal text', () => {
    const msg = 'API key must start with <code>sk-</code>.';
    setStatus(el, 'error', msg);
    // textContent must equal the raw string, not render <code>
    expect(el.textContent).toBe(msg);
    // innerHTML should be HTML-escaped, not contain a <code> element
    expect(el.querySelector('code')).toBeNull();
    expect(el.innerHTML).not.toContain('<code>');
  });

  it('does NOT execute script content passed as message', () => {
    const xss = '<img src=x onerror="window.__xss=true">';
    setStatus(el, 'error', xss);
    expect(el.textContent).toBe(xss);
    expect(el.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  it('does NOT execute injected event handler in type parameter', () => {
    // Even with a crafted type, className is set via template literal — no
    // event handler can execute because className is a plain string attribute.
    setStatus(el, 'error" onclick="window.__xss2=true"', 'msg');
    expect(window.__xss2).toBeUndefined();
  });

  it('preserves the exact message text including special characters', () => {
    const msg = 'Invalid key — please retry & check your settings.';
    setStatus(el, 'error', msg);
    expect(el.textContent).toBe(msg);
  });
});
