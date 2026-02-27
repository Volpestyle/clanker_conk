# Clanker Conk Technical Architecture

This document explains how the bot is wired, how data moves through the system, and the key runtime flows.

## 1. High-Level Components

Code entrypoint:
- `src/app.ts`: bootstraps storage, services, bot, and dashboard server.

Core runtime:
- `src/bot.ts`: Discord event handling, reply/react logic, initiative scheduling, and posting.
- `src/llm.ts`: model provider abstraction (OpenAI, Anthropic, xAI/Grok, or Claude Code), usage + cost logging, embeddings, image/video generation, ASR, and TTS.
- `src/memory.ts`: append-only daily journaling + LLM-based fact extraction + hybrid memory retrieval (lexical + vector).
- `src/discovery.ts`: external link discovery for initiative posts.
- `src/store.ts`: SQLite persistence and settings normalization.
- `src/publicHttpsEntrypoint.ts`: optional Cloudflare Quick Tunnel runtime for exposing local dashboard/API over public HTTPS.
- `src/screenShareSessionManager.ts`: tokenized browser screen-share session lifecycle and frame relay into voice stream-watch ingest.

Control plane:
- `src/dashboard.ts`: REST API and static dashboard hosting, including tunnel-host public/private route gating.
- `dashboard/src/*`: React dashboard (polling stats/actions/memory/settings and writing settings back).

Storage:
- `data/clanker.db`: runtime SQLite database.
- `memory/YYYY-MM-DD.md`: append-only daily journal files.
- `memory/MEMORY.md`: curated long-term snapshot for operator visibility and dashboard inspection.

## 2. Runtime Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Proc as Node Process
    participant Store as Store (SQLite)
    participant Memory as MemoryManager
    participant LLM as LLMService
    participant Disc as DiscoveryService
    participant Bot as ClankerBot
    participant Dash as DashboardServer
    participant Pub as PublicHttpsEntrypoint
    participant Scr as ScreenShareSessionManager
    participant Discord as Discord API

    Proc->>Store: init() (create tables + default settings)
    Proc->>LLM: new LLMService()
    Proc->>Disc: new DiscoveryService()
    Proc->>Memory: refreshMemoryMarkdown() (curation pass)
    Proc->>Bot: new ClankerBot(...)
    Proc->>Dash: createDashboardServer(...)
    Proc->>Bot: start()
    Proc->>Pub: start() (optional cloudflared tunnel)
    Proc->>Scr: initialize tokenized share-session manager
    Bot->>Discord: login()
    Bot->>Bot: start memory timer (5m)
    Bot->>Bot: start initiative timer (60s tick)
    Bot->>Bot: schedule startup tasks (~4.5s delay)
```

## 3. Data Model (SQLite)

Main tables created in `src/store.ts`:
- `settings`: single `runtime_settings` JSON blob.
- `messages`: normalized message history (user + bot messages).
- `actions`: event log (replies, reactions, initiative posts, llm/image calls, errors) with `usd_cost`.
- `memory_facts`: LLM-extracted durable facts with type/confidence/evidence.
- `memory_fact_vectors_native`: sqlite-vec-compatible embeddings per fact/model for semantic recall.
- `shared_links`: external links already posted (for dedupe windows).

Table relationship diagram (logical relationships):

```mermaid
erDiagram
    SETTINGS {
        string key PK
        text value
        datetime updated_at
    }

    MESSAGES {
        string message_id PK
        datetime created_at
        string guild_id
        string channel_id
        string author_id
        string author_name
        int is_bot
        text content
        string referenced_message_id
    }

    ACTIONS {
        int id PK
        datetime created_at
        string guild_id
        string channel_id
        string message_id
        string user_id
        string kind
        text content
        text metadata
        float usd_cost
    }

    MEMORY_FACTS {
        int id PK
        datetime created_at
        datetime updated_at
        string guild_id
        string channel_id
        string subject
        string fact
        string fact_type
        string evidence_text
        string source_message_id
        float confidence
        int is_active
    }

    MEMORY_FACT_VECTORS_NATIVE {
        int fact_id
        string model
        int dims
        blob embedding_blob
        datetime updated_at
    }

    SHARED_LINKS {
        string url PK
        datetime first_shared_at
        datetime last_shared_at
        int share_count
        string source
    }

    MESSAGES ||--o{ ACTIONS : "message_id (context/trigger)"
    MESSAGES ||--o{ MEMORY_FACTS : "source_message_id"
    MEMORY_FACTS ||--o{ MEMORY_FACT_VECTORS_NATIVE : "fact_id"
    MESSAGES ||--o{ MESSAGES : "referenced_message_id"
```

Note: the implementation uses logical joins and lookups; SQLite foreign-key constraints are not currently declared.

Cost aggregation:
- `llm_call` rows store `usd_cost`.
- `/api/stats` uses `Store.getStats()` to sum total and daily LLM spend.

## 4. Settings Flow

Settings are patched through dashboard API and normalized in `Store.patchSettings()` / `normalizeSettings()`:
- clamping numeric ranges,
- sanitizing list fields,
- defaulting missing keys,
- ensuring initiative/discovery config is always valid.

The bot reads settings at decision time (`store.getSettings()`), so updates apply without restart.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Dashboard UI
    participant API as /api/settings
    participant Store as Store
    participant Bot as ClankerBot

    UI->>API: PUT settings patch
    API->>Store: patchSettings(patch)
    Store->>Store: deepMerge + normalizeSettings
    Store->>Store: UPDATE settings JSON
    API-->>UI: normalized settings
    Bot->>Store: getSettings() on next event/tick
    Store-->>Bot: latest config
```

## 5. Message Event Flow (Replies + Reactions)

Entrypoint: Discord `messageCreate` handler in `ClankerBot`.

```mermaid
sequenceDiagram
    autonumber
    participant Discord as Discord
    participant Bot as ClankerBot
    participant Store as Store
    participant Memory as MemoryManager
    participant LLM as LLMService

    Discord->>Bot: messageCreate(message)
    Bot->>Store: recordMessage(incoming)
    Bot->>Store: getSettings()
    Bot->>Bot: channel/user/bot guards

    alt memory enabled
      Bot->>Memory: ingestMessage()
      Memory->>Memory: append entry to memory/YYYY-MM-DD.md
      Memory->>LLM: extractMemoryFacts() (strict JSON extraction)
      LLM->>Store: logAction(memory_extract_call / memory_extract_error)
      Memory->>Store: addMemoryFact() / logAction(memory_fact)
      Memory->>Memory: queue curated refresh of MEMORY.md
    end

    par Reaction path
      Bot->>LLM: generate() for reaction decision
      LLM->>Store: logAction(llm_call or llm_error)
      Bot->>Discord: message.react(emoji)
      Bot->>Store: logAction(reacted)
    and Reply path
      Bot->>Memory: buildPromptMemorySlice() (hybrid fact retrieval)
      Bot->>LLM: generate() for reply
      LLM->>Store: logAction(llm_call or llm_error)
      Bot->>Discord: reply() or send()
      Bot->>Store: recordMessage(outgoing)
      Bot->>Store: logAction(sent_reply or sent_message)
    end
```

Key guardrails:
- channel allow/block lists.
- blocked users.
- per-hour message and reaction limits.
- minimum seconds between bot messages.
- direct-address and random-chance gating for replies.

## 6. Initiative Post Flow

Initiative logic runs every 60 seconds, but posting depends on schedule rules and caps.

```mermaid
sequenceDiagram
    autonumber
    participant Tick as 60s Timer
    participant Bot as ClankerBot
    participant Store as Store
    participant Disc as DiscoveryService
    participant LLM as LLMService
    participant Discord as Discord

    Tick->>Bot: maybeRunInitiativeCycle()
    Bot->>Store: getSettings()
    Bot->>Bot: eligibility checks (enabled, limits, cooldown)
    Bot->>Store: countInitiativePostsSince(24h)
    Bot->>Store: getLastActionTime(initiative_post)
    Bot->>Bot: evaluate schedule (even/spontaneous)

    alt due to post
      Bot->>Bot: pick initiative channel + hydrate recent messages
      Bot->>Disc: collect(...) if discovery enabled
      Disc->>Store: wasLinkSharedSince(...) during dedupe
      Bot->>LLM: generate() with initiative prompt
      LLM->>Store: logAction(llm_call or llm_error)
      Bot->>Bot: applyDiscoveryLinkPolicy()
      opt image post selected
        Bot->>LLM: generateImage()
        LLM->>Store: logAction(image_call or image_error)
      end
      Bot->>Discord: channel.send(payload)
      Bot->>Store: recordMessage(outgoing)
      Bot->>Store: recordSharedLink(url) for used links
      Bot->>Store: logAction(initiative_post + pacing/discovery metadata)
    else not due
      Bot->>Bot: return
    end
```

Scheduling modes:
- `even`: post only when elapsed time exceeds `max(minMinutesBetweenPosts, 24h/maxPostsPerDay)`.
- `spontaneous`: after min gap, uses probabilistic ramps + force-due bound.

## 7. Discovery Subsystem (Initiative Creativity)

`DiscoveryService.collect()`:
1. Builds topic seeds from preferred topics + recent chat text.
2. Fetches enabled sources in parallel:
   - Reddit hot JSON
   - Hacker News top stories
   - YouTube channel RSS
   - configured RSS feeds
   - optional X handles via Nitter RSS
3. Normalizes/filters candidates:
   - URL safety + tracking param cleanup
   - freshness window
   - NSFW filtering
   - repost dedupe against `shared_links`
4. Scores + ranks candidates and selects prompt shortlist.

If a cycle requires a link and model output includes none, bot can append one fallback discovered link or skip posting.

## 8. Dashboard Read/Write Patterns

Dashboard polling:
- `/api/stats` every 10s
- `/api/actions` every 10s
- `/api/memory` every 30s
- `/api/settings` on load (and manual reload after save)

Dashboard writes:
- `PUT /api/settings`: saves all settings.
- `POST /api/memory/refresh`: forces immediate memory markdown regeneration.

## 9. Action Log Kinds

Common `actions.kind` values in current runtime:
- Messaging/initiative: `sent_reply`, `sent_message`, `reply_skipped`, `initiative_post`, `automation_post`
- Reactions: `reacted`, `voice_soundboard_play`
- LLM + media generation: `llm_call`, `llm_error`, `image_call`, `image_error`, `video_call`, `video_error`, `gif_call`, `gif_error`
- Memory pipeline: `memory_fact`, `memory_extract_call`, `memory_extract_error`, `memory_embedding_call`, `memory_embedding_error`, `memory_migration`
- Search + video context: `search_call`, `search_error`, `video_context_call`, `video_context_error`
- Voice runtime: `voice_session_start`, `voice_session_end`, `voice_turn_in`, `voice_turn_out`, `voice_runtime`, `voice_intent_detected`, `voice_error`
- Speech services: `asr_call`, `asr_error`, `tts_call`, `tts_error`
- Automation updates: `automation_created`, `automation_updated`
- Generic failures: `bot_error`

These power the activity stream and metrics/cost widgets in the dashboard.

## 10. Failure Behavior

- LLM failures are logged (`llm_error`) and bubble to caller; bot-level wrappers log `bot_error`.
- Reaction failures (permission/emoji issues) are swallowed.
- Image generation failures fall back to text-only initiative posts.
- Discovery fetch failures are captured per source; initiative cycle can still continue with no links.
