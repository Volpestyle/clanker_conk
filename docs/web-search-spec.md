# Clanker Conk Web Search v2 Implementation Spec

## Status / Why this exists

Current web lookup is tightly coupled to Google Custom Search and a single provider path in `src/search.ts`. It fails closed when Google credentials are missing or restricted and the prompt layer then teaches the model to avoid web lookup entirely. This creates the "web search enabled in dashboard but bot refuses to search" behavior when either config or hourly budget gates are hit.

This spec replaces the Google-only implementation with a provider-agnostic, source-cited pipeline designed for Clanker Conk’s current architecture (`src/bot.ts` + prompt directives + `WebSearchService`).

---

## 1) Goals (adapted for Clanker Conk)

1. **Fast**: typical lookup flow completes in 2–8s in Discord reply path.
2. **Accurate**: prefer primary sources, fetch 1–3 pages, cite sources inline (`[1]`).
3. **Reliable**: provider fallback, bounded retries/timeouts, extraction quality checks.
4. **Safe**: SSRF protections, strict URL protocol/domain checks, rate limits.
5. **Bot-native**: preserve existing `[[WEB_SEARCH: ...]]` directive UX while upgrading internals.
6. **No legacy parallel path**: remove Google-specific implementation once v2 ships.

---

## 2) Current state constraints (what we adapt to)

- The bot does a **two-pass generation**:
  1. Model emits `[[WEB_SEARCH: query]]`.
  2. Bot executes search and reinvokes model with findings.
- Web search availability is controlled by:
  - dashboard setting `webSearch.enabled`
  - runtime config check (`isConfigured()` currently Google keys)
  - hourly budget (`maxSearchesPerHour` + action log counts)
- Search results are currently inserted into prompt context and cited as source IDs in final answer.

### Key issue to fix

`isConfigured()` currently means "Google key + engine id present." In v2 it must become "at least one enabled provider is configured." This removes false "cannot browse" behavior when Google is intentionally not used.

---

## 3) Target architecture

### 3.1 Core components

- **Search Orchestrator** (`src/search.ts` or split module): single entry used by bot.
- **Provider interface**: pluggable providers behind one contract.
- **Provider A (primary)**: Brave Search API.
- **Provider B (optional fallback)**: SerpApi (or Tavily if chosen later).
- **Fetcher/Extractor**:
  - Fast path: HTTP fetch + Readability extraction.
  - Fallback: Playwright render + Readability on rendered DOM.
- **Cache layer**:
  - in-memory LRU initially
  - optional Redis later for multi-instance scaling
- **Safety layer**:
  - URL normalization
  - DNS/IP private-range rejection
  - protocol/content-type/size guards

### 3.2 Request flow

1. Bot receives `[[WEB_SEARCH: query]]`.
2. `WebSearchService.searchAndRead()` executes:
   - `search(query)` via primary provider
   - fallback to secondary provider on timeout/5xx/provider failure
3. Select top candidates (default 1–3) using ranking rules.
4. For each candidate:
   - `fetchAndExtract(url)` (fast)
   - if extraction quality is poor -> `renderAndExtract(url)` (fallback)
5. Return normalized results with summaries + metadata to prompt builder.
6. Model writes final response with `[1]`, `[2]` citations.

---

## 4) Tooling contract (internal to bot/orchestrator)

Keep the existing directive contract with the model; add an internal typed contract in the search module.

```ts
type WebSearchInput = {
  query: string;
  recencyDays?: number;       // default 30
  siteInclude?: string[];
  siteExclude?: string[];
  maxResults?: number;        // default 8, cap 10
  maxPagesToRead?: number;    // default 3, cap 5
};

type WebSearchResult = {
  rank: number;
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  published?: string | null;
  provider: "brave" | "serpapi";
  pageTitle?: string | null;
  pageSummary?: string | null;
  pageError?: string | null;
  extractionMethod?: "fast" | "render" | null;
};

type WebSearchOutput = {
  query: string;
  results: WebSearchResult[];
  fetchedPages: number;
  providerUsed: "brave" | "serpapi";
  providerFallbackUsed: boolean;
};
```

---

## 5) Provider spec

### 5.1 Interface

```ts
interface SearchProvider {
  readonly name: "brave" | "serpapi";
  isConfigured(): boolean;
  search(input: WebSearchInput): Promise<{ results: WebSearchResult[] }>;
}
```

### 5.2 Provider selection logic

- Primary: Brave if configured.
- Secondary: SerpApi if configured.
- If both configured:
  - use Brave by default
  - fallback to SerpApi only on transient provider failures
- If only one configured: use that one.
- If none configured: return explicit configuration error surfaced in prompt as "web unavailable."

### 5.3 Env and config

Add:
- `BRAVE_SEARCH_API_KEY`
- `SERPAPI_API_KEY` (optional)

Deprecate/remove after migration:
- `GOOGLE_SEARCH_API_KEY`
- `GOOGLE_SEARCH_ENGINE_ID`

---

## 6) Extraction strategy

### 6.1 Fast path

- `fetch(url)` with 8s timeout, redirect follow, max download bytes (2–4MB).
- Parse with `jsdom` + `@mozilla/readability`.
- Return title/excerpt/text capped by `maxCharsPerPage`.

### 6.2 Bad extraction heuristics

Trigger render fallback when any condition is true:
- extracted text `< 800` chars and original HTML is large (`>50KB`)
- obvious JS wall text ("enable javascript", "please turn on JavaScript")
- very high link density and near-empty content

### 6.3 Render fallback (optional feature flag)

- Use Playwright chromium in library mode.
- Timeout 15s, `waitUntil: "domcontentloaded"` default.
- Re-run Readability on rendered HTML.
- Mark `extractionMethod: "render"`.

---

## 7) Reliability & safety requirements

### 7.1 Timeouts/retries

- Search provider call: timeout 5s, retry 1x on retryable failures.
- Fast fetch: timeout 8s, retry only for transient network/5xx.
- Render fetch: timeout 15s, no retry.

### 7.2 SSRF and URL policy

Reject before fetching:
- non-http(s) schemes
- localhost / loopback / link-local / RFC1918 private IPs
- `file://`, `ftp://`, `data:`

Perform DNS resolution and reject internal addresses even after redirects.

### 7.3 Content controls

- Max response body bytes: 4MB.
- Accepted types: `text/html`, `text/plain`.
- Truncate extracted text to settings cap.

### 7.4 Rate limiting & concurrency

Reuse existing budget model and add internal concurrency limits:
- max concurrent fetches: 5
- max concurrent render jobs: 2

---

## 8) Ranking and selection behavior for the agent

Prompt/tool instructions should enforce:
1. Prefer official docs / primary publishers.
2. For "latest" requests, prefer recent dates.
3. Fetch 1–3 pages by default.
4. Always cite source IDs.

Dedupe rules:
- normalize URLs (strip `utm_*`, fragments, redundant trailing slash)
- dedupe by normalized final URL
- collapse near-duplicate titles

---

## 9) Dashboard and settings changes

### 9.1 Keep

- `webSearch.enabled`
- `maxSearchesPerHour`
- `maxResults`
- `maxPagesToRead`
- `maxCharsPerPage`

### 9.2 Add

- `webSearch.providerOrder` (default `['brave','serpapi']`)
- `webSearch.recencyDaysDefault` (default 30)
- `webSearch.renderFallbackEnabled` (default true)
- `webSearch.maxConcurrentFetches` (default 5)
- `webSearch.maxConcurrentRenders` (default 2)

### 9.3 Remove

- Any Google-only labels/help text in dashboard and docs.

---

## 10) Observability

Log structured actions/metadata:
- `search_call`:
  - providerUsed, fallbackUsed, latencyMs, query, resultCount
- `search_error`:
  - provider, stage (`provider|fetch|extract|render`), attempts, error
- optional new events:
  - `search_render_fallback`
  - `search_cache_hit`

Maintain compatibility with existing stats cards by continuing to emit `search_call` and `search_error`.

---

## 11) Migration plan (no parallel legacy)

### Phase 1: Introduce provider abstraction
- Refactor `WebSearchService` to use `SearchProvider` interface.
- Add Brave provider.
- Keep existing output shape consumed by prompt formatter.

### Phase 2: Extraction upgrade
- Replace regex-only HTML extraction with Readability-based extraction.
- Add quality heuristics + optional Playwright fallback.

### Phase 3: Dashboard/config updates
- Add new settings fields and update UI labels.
- Update runtime config/env parsing for Brave/SerpApi.

### Phase 4: Remove legacy Google path
- Delete Google-specific env handling, provider code, and dashboard copy.
- Remove all conditional branches that mention Google as required config.

---

## 12) Testing plan

### Unit
- URL normalization and dedupe.
- SSRF guard (blocked hosts/protocols).
- extraction quality heuristic behavior.
- provider failover selection.

### Integration
- provider response parsing (mock Brave/SerpApi payloads).
- fetch/extract with HTML fixtures.
- retry/timeout behavior.

### Optional e2e
- scripted Discord message flow:
  - model requests `[[WEB_SEARCH: ...]]`
  - service returns findings
  - reply includes citations

---

## 13) Definition of done

- Web search works with Brave as primary provider and no Google dependency.
- Typical cited answer returns within 10s at default settings.
- JS-heavy pages can be summarized when render fallback is enabled.
- Search cannot access internal/private network targets.
- Bot no longer emits "missing Google configuration" messaging.

---

## 14) Non-goals (for this iteration)

- Full crawl/indexing pipeline.
- Multi-hop autonomous browsing beyond 1–3 source fetches.
- Paywall/captcha bypassing.
