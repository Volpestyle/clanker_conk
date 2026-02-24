# clanker_conk

AI-powered Discord bot persona: **clanker conk**.

Features:
- Random human-like interactions in allowed channels.
- Event-driven behavior only: reacts/responds when chat moves (no timer posting).
- Standalone non-reply posts restricted to configured `initiativeChannelIds` only.
- OpenAI or Anthropic support (runtime-configurable).
- Dashboard UI for settings, permissions, logs, memory, and cost tracking.
- Persistent memory and conversation history with `memory/MEMORY.md` regeneration.

## 1. Setup

```bash
cd /mnt/c/Users/volpe/clanker_conk
cp .env.example .env
npm install
```

Fill `.env`:
- `DISCORD_TOKEN`: your bot token.
- `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`.
- Optional: `DASHBOARD_TOKEN` (protects dashboard API).

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

## 4. Configure in dashboard

Use dashboard to:
- Set unsolicited reply chance and reaction chance separately.
- Configure allowed/blocked channels and users.
- Toggle reply/initiative/reaction permissions.
- Set standalone-post channel IDs (for your dedicated `clanker conk` channel).
- Choose LLM provider + model.
- Track accumulated API spend.
- Inspect bot actions and memory.

## 5. Notes

- This project stores runtime data in `./data/clanker.db`.
- `memory/MEMORY.md` is auto-regenerated from learned facts and recent highlights.
- Personality is intentionally slangy and playful but constrained by explicit limitations.
