# clanker_conk

AI-powered Discord bot persona: **clanker conk**.

Features:
- Random human-like interactions in allowed channels.
- Standalone non-reply posts restricted to configured `initiativeChannelIds` only.
- Initiative scheduler with `even` or `spontaneous` pacing modes.
- Creative discovery for initiative posts (Reddit, Hacker News, YouTube RSS, RSS feeds, optional X via Nitter).
- OpenAI or Anthropic support (runtime-configurable).
- Optional live web search for replies (Brave primary, SerpApi fallback), including page inspection from top results.
- Optional model-directed GIF replies via GIPHY search.
- Optional Grok Imagine image/video generation for complex visuals and clips.
- Video link understanding for YouTube/TikTok/embedded video links (captions first, optional ASR fallback, optional keyframes).
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
- `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`.
- Optional for Grok Imagine media generation: `XAI_API_KEY` (and optional `XAI_BASE_URL`, default `https://api.x.ai/v1`).
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

Recommended bot permissions in server:
- View Channels
- Send Messages
- Read Message History
- Add Reactions

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
- Web search v2 implementation spec: `docs/web-search-spec.md`
