# Contributing to Article Summarizer

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

**Prerequisites:** Node.js 18+, npm 9+

```bash
# 1. Clone the repo
git clone https://github.com/lightshadow1/browser-buddy.git
cd browser-buddy

# 2. Install dev dependencies
npm install

# 3. Run the test suite
npm test

# 4. Run linting
npm run lint

# 5. Build for both browsers
node build.js
# Outputs: dist/chrome/ and dist/firefox/
```

## Loading the Extension Locally

**Chrome:**

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked** → select `dist/chrome/`

**Firefox:**

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on** → select `dist/firefox/manifest.json`

## Project Structure

```
article-summarizer/
├── background/         Background service worker (OpenAI proxy)
├── content/            Content scripts (extractor + widget + entry point)
├── options/            Settings page
├── lib/                Vendored third-party libraries
├── icons/              Extension icons
├── tests/              Jest test suite
├── .github/            CI/CD workflows and GitHub templates
├── manifest.json       Chrome MV3 manifest
└── manifest.firefox.json  Firefox MV2 manifest
```

## Coding Standards

- **Style:** ESLint + Prettier enforced. Run `npm run lint` and `npm run format:check` before submitting.
- **No bundler:** All JS files are loaded directly via the manifest. Do not introduce a build-time bundler without discussion.
- **JSDoc:** All public functions must have JSDoc comments with `@param` and `@returns`.
- **Security:** Never use `eval`, `new Function`, or `innerHTML` without DOMPurify sanitization.
- **Tests:** New features must include corresponding unit tests in `tests/`. Run `npm test` to verify.

## Submitting a Pull Request

1. Fork the repository and create a branch: `git checkout -b feat/my-feature`
2. Make your changes, following the coding standards above
3. Run `npm run presubmit` (lint + format check + tests) — this must pass
4. Commit with a descriptive message
5. Open a PR against `main` with a clear description of what changes and why

## Reporting Issues

Use the GitHub issue templates:

- **Bug report:** Include browser + version, steps to reproduce, expected vs actual behaviour
- **Feature request:** Describe the use case and proposed solution

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
All contributors are expected to uphold it.
