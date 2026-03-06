# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

If you discover a security issue, please report it responsibly:

1. Email: security@browser-buddy.dev (or open a [GitHub Security Advisory](https://github.com/browser-buddy/article-summarizer/security/advisories/new))
2. Include a clear description of the vulnerability, steps to reproduce, and potential impact
3. We will acknowledge your report within 48 hours and aim to release a fix within 14 days

## Security Model

This extension handles sensitive data. Here is how we protect it:

### API Key Storage
- Your OpenAI API key is stored **only** in `chrome.storage.local` on your device
- It is **never** sent to any server other than `api.openai.com`
- It is **never** accessible to content scripts or the pages you visit
- All OpenAI API calls are made exclusively from the background service worker

### Content Isolation
- The chat widget runs inside a **shadow DOM** — it cannot be styled or accessed by the host page
- AI-generated HTML is sanitized with **DOMPurify** using a strict allowlist before rendering

### Permissions
- `storage` — to persist your API key and settings locally
- `activeTab` — to read article content only when you interact with the extension
- `https://api.openai.com/*` — to make API calls; no other hosts are contacted

### Data and Privacy
- Article text is sent to OpenAI's API using **your own API key**, subject to [OpenAI's privacy policy](https://openai.com/policies/privacy-policy)
- No telemetry, analytics, or data collection is performed by this extension
- No data is stored remotely — everything is local to your browser

## Out of Scope

- Issues in third-party vendored libraries (Readability.js, marked.js, DOMPurify) — please report those upstream
- Browser-level vulnerabilities
