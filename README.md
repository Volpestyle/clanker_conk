# clanker_conk

AI-powered Discord bot persona: **clanker conk**.

Features:
- Random human-like interactions in allowed channels.
- Standalone non-reply posts restricted to configured `initiativeChannelIds` only.
- Initiative scheduler with `even` or `spontaneous` pacing modes.
- Creative discovery for initiative posts (Reddit, Hacker News, YouTube RSS, RSS feeds, optional X via Nitter).
- OpenAI, Anthropic, or Grok (xAI) support (runtime-configurable).
- Optional live web search for replies (Brave primary, SerpApi fallback), including page inspection from top results.
- Optional model-directed GIF replies via GIPHY search.
- Optional Grok Imagine image/video generation for complex visuals and clips.
- Video link understanding for YouTube/TikTok/embedded video links (captions first, optional ASR fallback, optional keyframes).
- NL-controlled Discord voice sessions (join/leave/status) with session limits and runtime guards.
- Voice runtime mode selector: `voice_agent` (xAI realtime), `openai_realtime` (OpenAI Realtime), `gemini_realtime` (Gemini Live API), or `stt_pipeline` (STT -> shared chat LLM brain -> TTS).
- Stream-watch voice controls (`watch_stream`, `stop_watching_stream`, `stream_status`) with external frame ingest path.
- Dashboard UI for settings, permissions, logs, memory, and cost tracking.
- Two-layer memory with append-only daily logs and curated `memory/MEMORY.md` distillation.

## 1. Setup

```bash
cd /mnt/c/Users/volpe/clanker_conk
cp .env.example .env
npm install
```

Fill `.env`:
- `DISCORD_TOKEN`: your bot token.
- `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and/or `XAI_API_KEY`.
- `XAI_API_KEY`: required for Grok text models and `voice_agent` mode, and also used for Grok Imagine media generation.
- `OPENAI_API_KEY`: required for `voice.openaiRealtime` mode and `voice.sttPipeline` mode.
- `GOOGLE_API_KEY`: required for `voice.geminiRealtime` mode and stream-watch frame commentary.
- `XAI_BASE_URL`: optional xAI API base URL override (default `https://api.x.ai/v1`).
- Optional for live web search: `BRAVE_SEARCH_API_KEY` (primary) and/or `SERPAPI_API_KEY` (fallback).
- Optional for model-directed GIF replies: `GIPHY_API_KEY` (and optional `GIPHY_RATING`, default `pg-13`).
- Optional: `DASHBOARD_TOKEN` (protects dashboard API).
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
npm run start
```

`start` builds the React dashboard and then starts bot + dashboard together.
- Dashboard URL: `http://localhost:8787` (or your `DASHBOARD_PORT` value)

## 3.1 Keep It Running Locally

- If your computer is asleep, the bot is paused. Prevent host sleep for always-on behavior.
- Run the bot under a process supervisor so it restarts after crashes/reboots.

Example with PM2:

```bash
npm install -g pm2
pm2 start npm --name clanker-conk -- run start
pm2 save
pm2 startup
```

Windows host sleep settings (for WSL users):
- Set **Sleep** to **Never** while plugged in.
- Allow display-off if needed; only system sleep needs to be disabled.

## 4. Configure in dashboard

Use dashboard to:
- Set unsolicited reply chance and reaction chance separately.
- Configure allowed/blocked channels and users.
- Toggle reply/initiative/reaction permissions.
- Set standalone-post channel IDs (for your dedicated `clanker conk` channel).
- Configure initiative pacing (`even` or `spontaneous`) and spontaneity.
- Configure discovery source mix, link frequency, freshness, dedupe window, and topic/source lists.
- Configure live web search limits (hourly cap, provider order, recency, results/query, pages inspected, and extraction settings).
- Enable/disable model-directed GIF replies and set GIF lookup budget.
- Configure allowed image/video generation models, simple/complex image routing models, and per-24h media budgets.
- Choose LLM provider + model.
- Choose voice runtime mode (`voice_agent`, `openai_realtime`, `gemini_realtime`, or `stt_pipeline`) and tune provider-specific realtime/STT/TTS settings.
- Configure stream-watch ingest guardrails and use `/api/voice/stream-ingest/frame` for external frame relay.
- Track accumulated API spend.
- Inspect bot actions and memory.

## 5. Notes

- This project stores runtime data in `./data/clanker.db`.
- `memory/YYYY-MM-DD.md` grows append-only with user-message journal entries.
- `memory/MEMORY.md` is periodically curated from durable facts plus recent daily logs.
- Personality is intentionally slangy and playful but constrained by explicit limitations.

## 6. Technical Docs

- Architecture and flow diagrams: `docs/technical-architecture.md`
- Initiative discovery product spec: `docs/initiative-discovery-spec.md`
- Voice agent product spec: `docs/voice-agent-spec.md`
- Gemini realtime + stream-watch spec: `docs/gemini-realitme-integration.md`
- Web search v2 implementation spec: `docs/web-search-spec.md`
