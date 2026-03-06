/**
 * browser-polyfill.js — Minimal cross-browser shim.
 *
 * In Firefox, `browser` is the native extension API (Promise-based).
 * In Chrome, only `chrome` exists in content scripts; `browser` may not be defined.
 * This file must be loaded FIRST in content_scripts and background.
 *
 * Uses `var` intentionally so it can shadow the global without a redeclaration error.
 */
/* global chrome */
// eslint-disable-next-line no-unused-vars
var browser = (function () {
  if (typeof globalThis.browser !== 'undefined') {
    return globalThis.browser;
  }
  if (typeof globalThis.chrome !== 'undefined') {
    return globalThis.chrome;
  }
  throw new Error('[browser-polyfill] No extension API found (browser or chrome).');
})();
