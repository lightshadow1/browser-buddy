#!/usr/bin/env node
/**
 * build.js — Cross-browser build script for Article Summarizer extension.
 *
 * Usage:
 *   node build.js                  # Build both Chrome and Firefox
 *   node build.js --target chrome  # Build Chrome only
 *   node build.js --target firefox # Build Firefox only
 *
 * Outputs:
 *   dist/chrome/   — Ready to load unpacked in Chrome
 *   dist/firefox/  — Ready to load as temporary add-on in Firefox
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const SOURCE_DIRS = ['background', 'content', 'options', 'lib', 'icons'];

const args = process.argv.slice(2);
const target = (() => {
  const idx = args.indexOf('--target');
  if (idx !== -1) {
    return args[idx + 1];
  }
  const eq = args.find((a) => a.startsWith('--target='));
  return eq ? eq.split('=')[1] : 'all';
})();

if (!['all', 'chrome', 'firefox'].includes(target)) {
  console.error(`Unknown target: ${target}. Use chrome, firefox, or omit for all.`);
  process.exit(1);
}

/**
 * Recursively copy a directory.
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Build for a specific browser target.
 * @param {'chrome'|'firefox'} browser
 */
function buildTarget(browser) {
  const outDir = path.join(DIST, browser);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  // Copy source directories
  for (const dir of SOURCE_DIRS) {
    const srcDir = path.join(ROOT, dir);
    if (fs.existsSync(srcDir)) {
      copyDir(srcDir, path.join(outDir, dir));
    }
  }

  // Write the correct manifest
  if (browser === 'chrome') {
    fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(outDir, 'manifest.json'));
  } else {
    fs.copyFileSync(path.join(ROOT, 'manifest.firefox.json'), path.join(outDir, 'manifest.json'));
  }

  console.log(`✓ Built ${browser} → dist/${browser}/`);
}

if (target === 'all' || target === 'chrome') {
  buildTarget('chrome');
}
if (target === 'all' || target === 'firefox') {
  buildTarget('firefox');
}

console.log('\nDone. To install:');
console.log('  Chrome:  chrome://extensions → Enable Dev Mode → Load unpacked → dist/chrome/');
console.log(
  '  Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on → dist/firefox/manifest.json'
);
