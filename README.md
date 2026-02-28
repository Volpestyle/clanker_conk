# clanker_conk

AI-powered Discord bot persona: **clanker conk**.

Features:
- Random human-like interactions in allowed channels.
- Standalone initiative posts stay restricted to `initiativeChannelIds`; reply turns may also post channel-level comments when a turn is not directly addressed.
- Initiative scheduler with `even` or `spontaneous` pacing modes.
- Natural-language scheduled automations (create/list/pause/resume/delete) with persistent runs.
- Creative discovery for initiative posts (Reddit, Hacker News, YouTube RSS, RSS feeds, optional X via Nitter).
- OpenAI, Anthropic, Grok (xAI), or Claude Code CLI support (runtime-configurable).
- Optional live web search for replies (Brave primary, SerpApi fallback), including page inspection from top results.
- Optional model-directed GIF replies via GIPHY search.
- Optional Grok Imagine image/video generation for complex visuals and clips.
- Video link understanding for YouTube/TikTok/embedded video links (captions first, optional ASR fallback, optional keyframes).
- NL-controlled Discord voice sessions (join/leave/status) with session limits and runtime guards.
- Voice runtime mode selector: `voice_agent` (xAI realtime), `openai_realtime` (OpenAI Realtime), `gemini_realtime` (Gemini Live API), or `stt_pipeline` (STT -> brain LLM -> TTS).
- Stream-watch voice controls (`watch_stream`, `stop_watching_stream`, `stream_status`) with external frame ingest path.
- Model-directed screen-share link offers (`screenShareIntent`) with temporary browser capture links (localhost fallback or public HTTPS).
- Optional auto-managed public HTTPS dashboard entrypoint via Cloudflare Quick Tunnel.
- Dashboard UI for settings, permissions, logs, memory, and cost tracking.
- Dashboard automation visibility endpoints: `/api/automations` and `/api/automations/runs`.
- Two-layer memory with append-only daily logs and curated `memory/MEMORY.md` distillation.

## 1. Setup

```bash
cd /path/to/clanker_conk-master
cp .env.example .env
bun install
```

Fill `.env`:
- `DISCORD_TOKEN`: your bot token.
- `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and/or `XAI_API_KEY`.
- Optional for `claude-code` provider: `claude` CLI available on `PATH` in the same runtime environment that starts the bot.
- `XAI_API_KEY`: required for Grok text models and `voice_agent` mode, also used for Grok Imagine media generation, and required for stream-watch speech output in `voice_agent`.
- `OPENAI_API_KEY`: required for `voice.openaiRealtime` mode and `voice.sttPipeline` mode; also used as the preferred vision fallback for stream-watch when VC mode is `voice_agent`.
- `GOOGLE_API_KEY`: required for `voice.geminiRealtime` mode and stream-watch commentary when VC mode is `gemini_realtime`.
- `XAI_BASE_URL`: optional xAI API base URL override (default `https://api.x.ai/v1`).
- Optional for live web search: `BRAVE_SEARCH_API_KEY` (primary) and/or `SERPAPI_API_KEY` (fallback).
- Optional for model-directed GIF replies: `GIPHY_API_KEY` (and optional `GIPHY_RATING`, default `pg-13`).
- Optional bind host for dashboard/API (defaults to loopback only): `DASHBOARD_HOST` (default `127.0.0.1`).
- Required for private dashboard/admin API access when public HTTPS is enabled: `DASHBOARD_TOKEN` (sent as `x-dashboard-token`).
- Optional for public tunnel stream-ingest access: `PUBLIC_API_TOKEN` (sent as `x-public-api-token`).
- Optional for auto public HTTPS entrypoint:
  - `PUBLIC_HTTPS_ENABLED=true`
  - `PUBLIC_HTTPS_PROVIDER=cloudflared`
  - optional `PUBLIC_HTTPS_TARGET_URL` (defaults to `http://127.0.0.1:${DASHBOARD_PORT}`)
  - optional `PUBLIC_HTTPS_CLOUDFLARED_BIN` (defaults to `cloudflared`)
  - optional `PUBLIC_SHARE_SESSION_TTL_MINUTES` (default `12`, clamp `2..30`)
  - if disabled, screen-share links still work locally via `http://127.0.0.1:${DASHBOARD_PORT}/share/<token>` on the machine running the bot
- Optional but recommended for richer video understanding: install `ffmpeg` and `yt-dlp` on your system.

## 2. Discord bot permissions

Required intents:
- `Guilds`
- `GuildMessages`
- `GuildMessageReactions`
- `MessageContent`
- `GuildVoiceStates` (required when voice mode is enabled)

Recommended bot permissions in server:
- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Connect (voice)
- Speak (voice)
- Use Soundboard (voice soundboard features)
- Use External Sounds (only if `voice.soundboard.allowExternalSounds=true`)

## 3. Run

```bash
bun run start
```

`start` builds the React dashboard and then starts bot + dashboard together.
- Dashboard URL: `http://localhost:8787` (or your `DASHBOARD_PORT` value)
- Public HTTPS status: `GET /api/public-https` and in `/api/stats -> runtime.publicHttps`

## 3.1 Public HTTPS Entrypoint (Cloudflare Quick Tunnel, optional for remote users)

Install `cloudflared` and set:

```bash
PUBLIC_HTTPS_ENABLED=true
```

Then start the app normally (`bun run start`). The app will spawn:

```bash
cloudflared tunnel --url http://127.0.0.1:<DASHBOARD_PORT> --no-autoupdate
```

When tunnel bootstrap succeeds, the public URL appears in:
- dashboard metrics (`Public HTTPS`)
- `/api/public-https`
- action stream (`public_https_entrypoint_ready`)

Public/private gating defaults:
- Tunnel ingress remains allowlisted and authenticated; dashboard/admin routes stay private.
- Canonical route-gating and auth behavior: `docs/public-https-entrypoint-spec.md`.

## 3.2 Keep It Running Locally

- If your computer is asleep, the bot is paused. Prevent host sleep for always-on behavior.
- Run the bot under a process supervisor so it restarts after crashes/reboots.

Example with PM2:

```bash
bun add --global pm2
pm2 start "bun run start" --name clanker-conk
pm2 save
pm2 startup
```

Windows host sleep settings (for WSL users):
- Set **Sleep** to **Never** while plugged in.
- Allow display-off if needed; only system sleep needs to be disabled.

## 4. Configure in dashboard

Use dashboard to:
- Set unsolicited reply eagerness separately for initiative vs non-initiative channels, plus reaction eagerness.
- Configure allowed/blocked channels and users.
- Toggle reply/initiative/reaction permissions.
- Set standalone-post channel IDs (for your dedicated `clanker conk` channel).
- Configure initiative pacing (`even` or `spontaneous`) and spontaneity.
- Configure discovery source mix, link frequency, freshness, dedupe window, and topic/source lists.
- Configure live web search limits (hourly cap, provider order, recency, results/query, pages inspected, and extraction settings).
- Enable/disable model-directed GIF replies and set GIF lookup budget.
- Configure allowed image/video generation models, simple/complex image routing models, and per-24h media budgets.
- Choose LLM provider + model.
- Optionally use a dedicated provider/model for reply follow-up regenerations (web/memory lookup passes).
- Choose voice runtime mode (`voice_agent`, `openai_realtime`, `gemini_realtime`, or `stt_pipeline`) and tune provider-specific realtime/STT/TTS settings.
- Configure stream-watch ingest guardrails and use `/api/voice/stream-ingest/frame` for external relay (`DASHBOARD_TOKEN` or `PUBLIC_API_TOKEN`) or tokenized `/api/voice/share-session/:token/frame`.
- Track accumulated API spend.
- Inspect bot actions and memory.

## 5. Notes

- This project stores runtime data in `./data/clanker.db`.
- `memory/YYYY-MM-DD.md` grows append-only with user-message journal entries.
- `memory/MEMORY.md` is periodically curated from durable facts plus recent daily logs.
- Personality is intentionally slangy and playful but constrained by explicit limitations.

## 6. Technical Docs

- Architecture and flow diagrams: `docs/technical-architecture.md`
- Reply decision policy (text + voice): `docs/reply-decision-flow.md`
- Replay harness guide (flooding + authoring): `docs/replay-test-suite.md`
- Initiative discovery product spec: `docs/initiative-discovery-spec.md`
- Public HTTPS entrypoint + relay design spec: `docs/public-https-entrypoint-spec.md`
- Screen-share link flow spec: `docs/screen-share-link-spec.md`
