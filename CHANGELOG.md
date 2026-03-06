# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-06

### Added
- Floating chat widget injected via shadow DOM (isolated from host page styles)
- Article extraction using Mozilla Readability with paragraph-level indexing
- Summarize action: streams GPT-4o-mini response with `[p-N]` references
- Follow-up Q&A with full conversation history and reference grounding
- Clickable reference chips that scroll to and highlight source paragraphs
- OpenAI API key management via options page with live validation
- Chrome (Manifest V3) and Firefox (Manifest V2) support from a single codebase
- Cross-browser build script (`node build.js`)
- Automated test suite (Jest + jsdom) for extraction logic and service worker
- ESLint, Prettier, and npm scripts for lint/test/build
- GitHub Actions CI workflow (lint + test + build on every PR)
- GitHub Actions release workflow (zipped artifacts on tag push)
- Open source governance: LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
