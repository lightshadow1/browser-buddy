# Article Summarizer Chrome/Firefox Extension — Code Spec v1.0

## 1. Product Overview

A browser extension that injects a floating chatbot widget onto any webpage. Users can summarize articles, ask follow-up questions, and get answers grounded with paragraph-level references back to the source text. Powered by OpenAI GPT-4o-mini.

**Target browsers:** Chrome (Manifest V3) + Firefox (WebExtensions)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Browser Tab                    │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │          Content Script (injected)         │  │
│  │                                            │  │
│  │  ┌──────────┐   ┌──────────────────────┐   │  │
│  │  │ Chat FAB │──▶│  Chat Panel (shadow  │   │  │
│  │  │ (bubble) │   │  DOM isolated)       │   │  │
│  │  └──────────┘   │                      │   │  │
│  │                 │  - Message list       │   │  │
│  │                 │  - Input bar          │   │  │
│  │                 │  - Reference chips    │   │  │
│  │                 └──────────────────────┘   │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  Article Extractor Module            │  │  │
│  │  │  - Readability.js (Mozilla)          │  │  │
│  │  │  - Paragraph indexer                 │  │  │
│  │  │  - Scroll-to-reference handler       │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
│                        ▲                         │
│                        │ chrome.runtime.sendMessage
│                        ▼                         │
│  ┌────────────────────────────────────────────┐  │
│  │       Background Service Worker            │  │
│  │                                            │  │
│  │  - OpenAI API proxy (keeps key secure)     │  │
│  │  - Token/context window management         │  │
│  │  - Rate limiting                           │  │
│  │  - Conversation history (per tab)          │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │       Options Page (settings)              │  │
│  │  - API key input                           │  │
│  │  - Model selector (future)                 │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component             | Role                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| **Content Script**    | Extracts article, renders chat widget, handles reference clicks      |
| **Background Worker** | Proxies OpenAI calls, manages API key securely, tracks conversations |
| **Options Page**      | User enters/updates their OpenAI API key                             |

---

## 3. File Structure

```
article-summarizer/
├── manifest.json              # Extension manifest (Manifest V3)
├── manifest.firefox.json      # Firefox overrides (if needed, merged at build)
├── background/
│   └── service-worker.js      # Background service worker
├── content/
│   ├── content.js             # Main content script entry
│   ├── extractor.js           # Article extraction + paragraph indexing
│   ├── widget.js              # Chat widget UI (injected via shadow DOM)
│   └── widget.css             # Chat widget styles
├── options/
│   ├── options.html           # Settings page
│   ├── options.js             # Settings logic
│   └── options.css            # Settings styles
├── lib/
│   └── readability.js         # Mozilla Readability (vendored)
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── build.js                   # Simple build script for cross-browser
└── README.md
```

---

## 4. Manifest (Chrome — Manifest V3)

```jsonc
{
  "manifest_version": 3,
  "name": "Article Summarizer",
  "version": "0.1.0",
  "description": "Summarize any article and chat about it with AI-powered references.",
  "permissions": [
    "storage", // API key + settings
    "activeTab", // Access current tab on user action
  ],
  "host_permissions": ["https://api.openai.com/*"],
  "background": {
    "service_worker": "background/service-worker.js",
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": [
        "lib/readability.js",
        "content/extractor.js",
        "content/widget.js",
        "content/content.js",
      ],
      "css": [], // CSS injected via shadow DOM, not here
      "run_at": "document_idle",
    },
  ],
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": false,
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
}
```

**Firefox differences:** Firefox still supports `manifest_version: 2` more reliably. Use a build step to produce `manifest.json` per target. Key differences: `background.scripts` array instead of `service_worker`, `browser_specific_settings.gecko.id` required.

---

## 5. Module Specs

### 5.1 Article Extractor (`content/extractor.js`)

**Purpose:** Extract readable article content and build a paragraph index for references.

```ts
// --- Types ---

interface IndexedParagraph {
  id: string; // "p-0", "p-1", etc.
  text: string; // Plain text content
  element: HTMLElement; // Reference to original DOM node
  charStart: number; // Character offset in full article text
  charEnd: number;
}

interface ExtractionResult {
  title: string;
  byline: string | null;
  siteName: string | null;
  url: string;
  fullText: string; // Concatenated plain text
  paragraphs: IndexedParagraph[]; // Indexed paragraphs
  extractedAt: string; // ISO timestamp
}

// --- Public API ---

function extractArticle(): ExtractionResult | null;
// Uses Mozilla Readability on a cloned document.
// Walks the Readability output DOM and indexes every <p>, <li>, <blockquote>,
// <h1>-<h6> as a paragraph. Assigns sequential IDs.
// Returns null if Readability fails (non-article page).

function scrollToReference(paragraphId: string): void;
// Scrolls the original page to the matched paragraph element.
// Adds a brief highlight animation (CSS class toggle, 2s fade).

function getParagraphById(id: string): IndexedParagraph | null;
```

**Key decisions:**

- Use Mozilla's Readability.js (MIT licensed, same as Firefox Reader View)
- Clone the document before parsing (Readability mutates DOM)
- Index granularity = block-level elements (not sentences) — simpler, more reliable
- Store element references for scroll-to behavior
- Max article size sent to API: **first 12,000 tokens** (~48,000 chars). Truncate with a note.

---

### 5.2 Chat Widget (`content/widget.js`)

**Purpose:** Render floating chat UI, fully isolated from host page styles.

#### UI Layout

```
┌──────────────────────────────────┐
│  ✨ Article Summarizer      ─  ✕ │  ← Header (draggable)
├──────────────────────────────────┤
│                                  │
│  ┌────────────────────────────┐  │
│  │ 🤖 Here's a summary of    │  │  ← AI message bubble
│  │ this article:              │  │
│  │                            │  │
│  │ The article discusses...   │  │
│  │                            │  │
│  │ [1] ← clickable ref chip  │  │
│  └────────────────────────────┘  │
│                                  │
│  ┌────────────────────────────┐  │
│  │ 👤 What about the second  │  │  ← User message bubble
│  │ point on pricing?          │  │
│  └────────────────────────────┘  │
│                                  │
│  ┌────────────────────────────┐  │
│  │ 🤖 According to the       │  │
│  │ article [2][3]:            │  │
│  │ ...                        │  │
│  └────────────────────────────┘  │
│                                  │
├──────────────────────────────────┤
│  [Summarize] [Ask a question...] │  ← Input bar
│                              ➤  │
└──────────────────────────────────┘

   ┌──────┐
   │  💬  │  ← Floating Action Button (collapsed state)
   └──────┘
```

#### Behavior

| Action                     | Result                                                      |
| -------------------------- | ----------------------------------------------------------- |
| Click FAB                  | Toggle panel open/close                                     |
| Click "Summarize" button   | Extract article → send to background → stream summary       |
| Type + Enter               | Send follow-up question to background                       |
| Click `[1]` reference chip | Call `scrollToReference("p-3")` → page scrolls + highlights |
| Hover reference chip       | Tooltip shows paragraph preview (first 100 chars)           |
| Click `✕`                  | Close panel (FAB remains)                                   |
| Click `─`                  | Minimize to FAB                                             |
| Drag header                | Reposition panel (persist position in session)              |

#### Technical Requirements

- **Shadow DOM:** Attach widget inside a shadow root to isolate from host CSS. All styles are self-contained.
- **Z-index:** Use `2147483647` (max) for FAB and panel.
- **Responsive:** Panel default size 380×520px. Min-width 300px. On viewports < 500px, panel goes full-width bottom sheet.
- **Streaming:** Render AI responses token-by-token as they arrive (via background message passing).
- **Markdown rendering:** AI responses may include bold, lists, code. Use a lightweight markdown-to-HTML converter (e.g., marked.js minified, or simple regex-based for MVP).
- **Reference format in AI responses:** `[1]`, `[2]`, etc. Parse these and render as clickable chips that map to paragraph IDs.

---

### 5.3 Background Service Worker (`background/service-worker.js`)

**Purpose:** Securely call OpenAI API, manage conversation state per tab.

```ts
// --- Types ---

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Conversation {
  tabId: number;
  url: string;
  articleText: string; // Extracted article (truncated)
  paragraphs: { id: string; text: string }[]; // For reference mapping
  messages: Message[];
}

// --- Storage ---
// In-memory Map<number, Conversation> keyed by tabId.
// Cleared when tab closes or navigates to new URL.

// --- Message Handlers ---

// 1. SUMMARIZE
// Receives: { action: "summarize", article: ExtractionResult }
// Builds system prompt (see §6), sends to OpenAI, streams response back.
// Returns: streamed chunks via port (chrome.runtime.connect)

// 2. FOLLOW_UP
// Receives: { action: "followUp", question: string }
// Appends user question to conversation, sends full history, streams back.

// 3. GET_STATUS
// Receives: { action: "getStatus" }
// Returns: { hasApiKey: boolean, hasConversation: boolean }
```

#### OpenAI API Integration

```
Endpoint: POST https://api.openai.com/v1/chat/completions
Model:    gpt-4o-mini
Stream:   true (SSE)
```

**Request flow:**

1. Content script sends message to background
2. Background opens persistent connection (port) for streaming
3. Background calls OpenAI with `stream: true`
4. Background reads SSE chunks, forwards each `delta.content` to content script via port
5. On `[DONE]`, send completion signal

**Error handling:**

| Error             | Action                                                    |
| ----------------- | --------------------------------------------------------- |
| 401 Unauthorized  | Tell user: "Invalid API key. Check settings."             |
| 429 Rate limit    | Retry with exponential backoff (max 3 retries, 1s/2s/4s)  |
| 500+ Server error | Retry once, then show error message                       |
| Network error     | Show "Connection failed. Check your internet."            |
| Context too long  | Truncate article, retry. Inform user content was trimmed. |

**Token budget:**

- System prompt: ~500 tokens
- Article content: ~12,000 tokens max
- Conversation history: keep last 10 message pairs, drop oldest
- Total context target: ≤16,000 tokens (fits gpt-4o-mini's 128k, with huge headroom)

---

### 5.4 Options Page (`options/`)

Simple single-page settings UI.

**Fields:**

| Field          | Type            | Storage Key      | Validation                    |
| -------------- | --------------- | ---------------- | ----------------------------- |
| OpenAI API Key | password input  | `openai_api_key` | Starts with `sk-`, non-empty  |
| Model          | select (future) | `openai_model`   | Enum: `gpt-4o-mini`, `gpt-4o` |

**Storage:** Use `chrome.storage.local` (not sync — API keys shouldn't sync across devices).

**Validation on save:** Make a test call to `GET https://api.openai.com/v1/models` with the key. Show ✅ or ❌.

---

## 6. Prompt Engineering

### System Prompt (Summarize)

```
You are an article summarizer. The user has provided an article from a webpage.

Your job:
1. Provide a clear, structured summary of the article.
2. For every claim or key point, include a reference to the source paragraph using the format [N] where N maps to the paragraph index.
3. Keep the summary concise — aim for 3-5 key points.
4. Use markdown formatting (bold for emphasis, bullet lists for points).

ARTICLE PARAGRAPHS:
{{#each paragraphs}}
[{{this.id}}]: {{this.text}}
{{/each}}

RULES:
- Every factual claim MUST have at least one [N] reference.
- If information spans multiple paragraphs, cite all relevant ones: [2][5].
- Do NOT make up information not in the article.
- If the article is too short or not really an article, say so briefly.
```

### System Prompt (Follow-up)

```
You are continuing a conversation about an article. The user has follow-up questions.

ARTICLE PARAGRAPHS:
{{#each paragraphs}}
[{{this.id}}]: {{this.text}}
{{/each}}

RULES:
- Answer ONLY based on the article content.
- Always include [N] references to support your answers.
- If the article doesn't cover the user's question, say "The article doesn't discuss this."
- Be concise.
```

---

## 7. Reference System

This is the core differentiator. Every AI response must ground claims in the source text.

### Flow

```
1. Extractor indexes paragraphs → [{ id: "p-0", text: "..." }, ...]

2. Paragraph texts are included in the system prompt as:
   [p-0]: First paragraph text...
   [p-1]: Second paragraph text...

3. AI responds with inline references:
   "The company reported growth [p-2] driven by cloud services [p-5][p-6]."

4. Widget parses [p-N] patterns in AI response via regex:
   /\[p-(\d+)\]/g

5. Each match is rendered as a clickable chip:
   <span class="ref-chip" data-ref="p-2" title="Preview...">[2]</span>

6. On click → content script calls scrollToReference("p-2")
   → original page scrolls to that paragraph
   → paragraph gets a 2-second highlight animation
```

### Reference Display

- In the chat: `[2]` rendered as a small pill/chip (styled, not raw text)
- On hover: tooltip shows first 100 characters of the referenced paragraph
- On click: smooth scroll + highlight on the actual page
- Multiple refs: `[2][5]` render as adjacent chips

---

## 8. Cross-Browser Compatibility

### Strategy: Single codebase, build-time manifest swap

| Feature       | Chrome (MV3)                      | Firefox                             |
| ------------- | --------------------------------- | ----------------------------------- |
| Manifest      | `manifest_version: 3`             | `manifest_version: 2` (more stable) |
| Background    | `service_worker`                  | `background.scripts` (persistent)   |
| API namespace | `chrome.*`                        | `browser.*` (Promise-based)         |
| Storage       | `chrome.storage.local`            | `browser.storage.local`             |
| Streaming     | Port via `chrome.runtime.connect` | Same API, different namespace       |

### Compatibility Shim (top of each file)

```js
const browser = globalThis.browser || globalThis.chrome;
```

This one-liner covers 90% of API differences. For the remaining edge cases (service worker vs background script), use the build step to swap the manifest and entry point.

### Build Script (`build.js`)

A simple Node script (no bundler for MVP):

1. Copy all files to `dist/chrome/` and `dist/firefox/`
2. For Firefox: replace `manifest.json` with Firefox-compatible version
3. For Firefox: wrap service worker as a background script
4. Output two folders ready for packaging

---

## 9. Data Flow Diagram

```
User clicks FAB
       │
       ▼
Widget opens (shadow DOM)
       │
       ▼
User clicks "Summarize"
       │
       ▼
extractor.extractArticle()
       │
       ├──▶ Readability.js parses cloned DOM
       │
       ├──▶ Walks output, indexes paragraphs
       │
       ▼
Content script sends to background:
  { action: "summarize", article: ExtractionResult }
       │
       ▼
Background builds prompt with paragraph index
       │
       ▼
Background calls OpenAI (stream: true)
       │
       ▼
SSE chunks arrive
       │
       ├──▶ Each chunk forwarded to content script via port
       │
       ▼
Widget renders tokens incrementally
       │
       ├──▶ Parses [p-N] references as they appear
       │
       ├──▶ Renders reference chips inline
       │
       ▼
User clicks [2] chip
       │
       ▼
scrollToReference("p-2")
       │
       ├──▶ Finds original DOM element
       │
       ├──▶ element.scrollIntoView({ behavior: "smooth" })
       │
       ▼
Paragraph highlighted for 2s (CSS animation)
```

---

## 10. Security Considerations

| Concern                    | Mitigation                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key exposure           | Stored in `chrome.storage.local`, never injected into page context. All API calls from background worker only.                                           |
| XSS via AI response        | Sanitize AI markdown output before injecting into shadow DOM. Allowlist: `<b>`, `<i>`, `<ul>`, `<li>`, `<p>`, `<code>`, `<span>`. Strip everything else. |
| Host page interference     | Shadow DOM isolates widget. No global CSS leaks in or out.                                                                                               |
| Content script permissions | Use `activeTab` — only activates on user interaction, not passively on all pages.                                                                        |
| OpenAI data policy         | User's own API key = user's own data relationship with OpenAI. Note this in README.                                                                      |

---

## 11. MVP Scope vs. Future

### MVP (v0.1) — Build This Now

- [x] Floating chat widget (shadow DOM)
- [x] Article extraction via Readability.js
- [x] Paragraph-level reference indexing
- [x] Summarize with references
- [x] Follow-up Q&A with references
- [x] Click reference → scroll + highlight
- [x] OpenAI API key via options page
- [x] GPT-4o-mini default
- [x] Chrome + Firefox support
- [x] Streaming responses
- [x] Basic error handling

### v0.2 — Polish

- [ ] Reference tooltip on hover (paragraph preview)
- [ ] Draggable/resizable panel
- [ ] Keyboard shortcuts (Cmd+Shift+S to summarize)
- [ ] Copy summary as markdown
- [ ] Dark mode (follows system preference)
- [ ] "Export chat" button

### v0.3 — Plugin System (Extension Architecture)

- [ ] Define `SummaryConnector` interface (see §12)
- [ ] Plugin registry + discovery
- [ ] Built-in connectors: Notion, Google Drive, Obsidian
- [ ] "Save to…" button in chat header
- [ ] Community connector template repo

---

## 12. Future: Plugin System Contract (Preview)

This is the interface third-party devs will implement. Not built in MVP, but the data model is designed to support it.

```ts
interface SummaryConnector {
  // Metadata
  id: string; // e.g., "notion", "google-drive"
  name: string; // Display name
  icon: string; // Data URI or URL
  version: string;

  // Lifecycle
  initialize(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  authenticate(): Promise<void>; // Handle OAuth / API key

  // Core action
  save(payload: SummaryPayload): Promise<SaveResult>;
}

interface SummaryPayload {
  title: string; // Article title
  url: string; // Source URL
  summary: string; // Markdown summary
  chat: ChatMessage[]; // Full conversation
  references: Reference[]; // Paragraph references used
  extractedAt: string; // ISO timestamp
}

interface Reference {
  id: string; // "p-3"
  text: string; // Paragraph content
  usedInMessages: number[]; // Which message indices cited this
}

interface SaveResult {
  success: boolean;
  link?: string; // URL to saved item (e.g., Notion page)
  error?: string;
}
```

### Connector Notes

| Target       | Auth Method  | Save Format                                        | Notes                             |
| ------------ | ------------ | -------------------------------------------------- | --------------------------------- |
| Notion       | OAuth 2.0    | Create page via API                                | Needs Notion integration setup    |
| Google Drive | OAuth 2.0    | Create Google Doc or .md file                      | Use Google Drive API v3           |
| Obsidian     | None (local) | Write .md file via Obsidian URI (`obsidian://new`) | No server needed, uses URI scheme |
| Webhook      | None         | POST JSON to user-configured URL                   | Simplest connector, good template |

---

## 13. Testing Strategy

### Manual Testing Checklist (MVP)

- [ ] Extension loads without errors in Chrome
- [ ] Extension loads without errors in Firefox
- [ ] FAB appears on a standard article page (e.g., Medium, NYT, Wikipedia)
- [ ] FAB does NOT appear on non-article pages (optional: always show, handle gracefully)
- [ ] Click FAB → panel opens
- [ ] Click Summarize → loading state shown
- [ ] Summary streams in with `[p-N]` references rendered as chips
- [ ] Click reference chip → page scrolls to correct paragraph
- [ ] Highlighted paragraph fades after 2 seconds
- [ ] Type follow-up question → get grounded response with references
- [ ] Invalid API key → clear error message
- [ ] No article content → graceful message ("Couldn't extract article")
- [ ] Very long article (>10k words) → truncation works, summary still accurate
- [ ] Panel close/minimize works
- [ ] Navigating to new page resets conversation

### Automated Tests (v0.2+)

- Unit tests for `extractArticle()` with sample HTML fixtures
- Unit tests for reference regex parsing
- Integration test: mock OpenAI response → verify reference chips render
- Cross-browser snapshot tests

---

## 14. Dependencies

| Package              | Version | Purpose                 | License              |
| -------------------- | ------- | ----------------------- | -------------------- |
| Readability.js       | latest  | Article extraction      | Apache 2.0           |
| marked.js (optional) | latest  | Markdown → HTML in chat | MIT                  |
| DOMPurify (optional) | latest  | Sanitize HTML output    | Apache 2.0 / MPL 2.0 |

**Zero build-time dependencies for MVP.** All libraries vendored (copied into `lib/`). No webpack, no npm at runtime. A simple copy-and-zip build.

---

## 15. Development Setup

```bash
# Clone the repo
git clone <repo-url>
cd article-summarizer

# No install needed for MVP (all vendored)

# Load in Chrome:
# 1. Go to chrome://extensions
# 2. Enable Developer Mode
# 3. Click "Load unpacked" → select project root

# Load in Firefox:
# 1. Go to about:debugging#/runtime/this-firefox
# 2. Click "Load Temporary Add-on" → select manifest.json

# Build for distribution:
node build.js          # outputs dist/chrome/ and dist/firefox/
```

---

## 16. Open Questions / Decisions for Developer

1. **Should the FAB appear on every page or only when an article is detected?**
   Recommendation: Always show, but change state (greyed out if no article found).

2. **Readability.js fallback:** What if Readability fails? Options: (a) show error, (b) fall back to `document.body.innerText` with basic cleanup.

3. **Token counting:** MVP can estimate with `text.length / 4`. For accuracy later, use `tiktoken` (WASM build exists for browser).

4. **Conversation persistence:** MVP keeps conversations in memory (lost on tab close). Should we persist to `chrome.storage.local` for recovery?

5. **Rate limiting UX:** Should we show token usage / estimated cost per query? Some users may appreciate cost awareness.
