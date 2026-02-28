# Initiative Creative Discovery Spec

## Goal
Make initiative channels feel alive and surprising by letting the bot discover fresh external content and turn it into native-feeling Discord posts.

## Outcomes
- Higher-quality initiative posts with real links and timely topics.
- Fewer repeats via persistent shared-link dedupe.
- Full control from dashboard without code edits.

## Product Behavior
1. On each initiative cycle that is due, bot gathers candidate links from enabled sources.
2. Discovery candidates are filtered by freshness window and repost-avoid window.
3. Highest-scoring candidates are injected into the initiative prompt as optional inspiration.
4. Bot writes one natural standalone message; if configured, it must include at least one discovered link.
5. Any links actually posted are recorded for dedupe on later cycles.

## Supported Sources (v1)
- Reddit hot feed (`r/...`)
- Hacker News top stories
- YouTube channel RSS
- Generic RSS feeds
- X handles via Nitter RSS (optional)

## Ranking Heuristics (v1)
- Source quality weight
- Topic overlap with recent channel messages + preferred topics
- Freshness decay
- Optional popularity boost
- Configurable randomness factor

## Safety & Guardrails
- HTTP/HTTPS only.
- Local/private hostnames blocked (`localhost`, RFC1918 IP ranges).
- Tracking query params stripped from URLs.
- Optional NSFW filtering.
- Hard caps on source fetch size and prompt candidate count.

## Dashboard Controls
Under `Autonomous Initiative Posts -> Creative Discovery`:
- Enable discovery
- Chance that initiative post should include links
- Max links/post
- Candidate count injected into prompt
- Freshness window (hours)
- Repost-avoid window (hours)
- Discovery randomness
- Source fetch limit
- Source toggles
- Preferred topics
- Source lists (subreddits, YouTube channel IDs, RSS feeds, X handles, Nitter base URL)

## Data Model
- New table: `shared_links`
  - `url` (PK)
  - `first_shared_at`
  - `last_shared_at`
  - `share_count`
  - `source`

## Observability
- `initiative_post` metadata now includes:
  - discovery enablement
  - required-link flag
  - topic seeds
  - candidate and selected counts
  - used links
  - source reports/errors

## Rollout Notes
- Start with discovery enabled + `linkChancePercent` around `65-80`.
- Keep `maxLinksPerPost=1-2` for non-spammy channel behavior.
- Keep freshness between `48-120` hours based on channel velocity.
