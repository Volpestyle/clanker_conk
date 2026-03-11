# Ambient Text Cycle

> **Scope:** Current shipped ambient text delivery cycle.
> Shared attention model: [`presence-and-attention.md`](presence-and-attention.md)
> Activity model overview: [`clanker-activity.md`](clanker-activity.md)
> Voice pipeline reference: [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md)

This document describes the text-side ambient delivery system in `src/bot/initiativeEngine.ts`.

## Core Model

One ambient text cycle handles the text spoke of `AMBIENT` attention:

- conversational chime-ins in active channels
- standalone proactive posts
- optional sharing of passive discovery feed items
- optional active curiosity through tools

This is not a second personality and not a separate “initiative mind.” It is the current text transport for ambient thoughts.

The discovery service is now feed infrastructure, not a separate delivery engine. It gathers candidates that the initiative prompt may consider alongside channel context and memory.

## Design Principles

- The model decides whether to post, what to say, which eligible channel fits, and whether links or media feel natural.
- Infrastructure decides when to consult the model and what context to provide.
- Discovery candidates are optional context, not assignments.
- `initiative.text.eagerness` is a probability gate before the LLM call, not a content rule.
- The model can always `[SKIP]`.
- Shared attention may be informed by voice context, but initiative delivery is still a text action.

## Runtime Flow

The runtime flow in `src/bot/initiativeEngine.ts` is:

1. `60s` initiative tick
2. Deterministic gates
3. Context assembly
4. Bounded tool loop
5. Post delivery or `[SKIP]`

### 1. Tick

The bot runs one in-process ambient text tick every `60s`.

There is no replay catchup after downtime. If the process is offline, skipped initiative opportunities are simply missed.

### 2. Deterministic Gates

Before the model is consulted for an ambient text thought, the runtime checks:

- `initiative.text.enabled`
- eligible channel pool is non-empty
- daily cap has not been reached
- minimum gap since the last initiative consideration has passed
- the eagerness probability roll passed

Canonical settings:

- `initiative.text.enabled`
- `initiative.text.eagerness`
- `initiative.text.minMinutesBetweenPosts`
- `initiative.text.maxPostsPerDay`

The canonical persisted action history for this cycle is the initiative action log:

- `initiative_post` counts as a surfaced ambient text thought
- `initiative_skip` starts the same minimum-gap cooldown after the bot looked around and decided to stay quiet

### 3. Context Assembly

When the gates pass, the runtime builds a prompt from:

- eligible channel summaries
- passive discovery feed candidates
- feed-source performance
- lightweight community-interest facts derived from recent activity
- durable memory
- behavior guidance and relevant behavioral memory

Channel summaries are built from recent stored messages, recent human activity, and time since the bot last posted.
Stored channel history can include linked voice-transcript rows alongside normal typed chat. The prompt labels those lines as `[vc]` so the model can use them as room context while still understanding that initiative delivery is a normal text-channel post.

Discovery context is fetched from `src/services/discovery.ts` and exposed as optional feed material. The model may ignore all of it.

### 4. Bounded Tool Loop

The initiative call uses the same broad tool philosophy as the reply pipeline, but with tighter budgets.

Canonical tool budget settings:

- `initiative.text.maxToolSteps`
- `initiative.text.maxToolCalls`

Tool availability:

- `web_search` and `browser_browse` are available only when `initiative.text.allowActiveCuriosity` is true
- `memory_search` is available when memory is enabled
- discovery source-management tools are available only when `initiative.discovery.allowSelfCuration` is true

### 5. Delivery

The final output can:

- `[SKIP]`
- post text to a selected eligible channel
- optionally request media generation (`image`, `video`, or `gif`)
- optionally include discovery links when they feel natural

Media availability is governed by `initiative.discovery.*` budgets and allowlists.

This delivery surface stays text-only even when the context that informed the thought included linked VC transcript rows.

## Canonical Channel Pool

The unified initiative pool is:

- `permissions.replies.replyChannelIds`

Other text permission surfaces still apply:

- `permissions.replies.allowedChannelIds`
- `permissions.replies.blockedChannelIds`
- `permissions.replies.blockedUserIds`

## Discovery In The Unified Model

Discovery is split into two roles:

1. `delivery`: handled by the unified initiative cycle
2. `collection`: handled by the discovery service and discovery settings

`initiative.discovery.*` now owns feed/media infrastructure such as:

- enabled source types
- subreddit / RSS / YouTube / X source lists
- source freshness and dedupe windows
- self-curation guardrails
- media generation budgets and model allowlists

The model can:

- ignore the feed and `[SKIP]`
- react to channel activity with no discovery content at all
- share a feed item
- use active curiosity tools to look something up before posting
- manage its own feed when self-curation is enabled

## Prompt Structure

The shipped ambient-text prompt in `src/prompts/promptText.ts` is structured like this:

```text
=== AMBIENT TEXT MODE ===
=== CHANNELS ===
=== YOUR FEED ===
=== FEED SOURCES ===
=== WHAT THIS COMMUNITY IS INTO ===
=== MEMORY ===
=== BEHAVIOR GUIDANCE ===
=== RELEVANT BEHAVIORAL MEMORY ===
=== CAPABILITIES ===
=== TASK ===
```

Behavior guidance comes from memory-backed `guidance` and `behavioral` facts.

The prompt explicitly frames this cycle as an ambient text action. Voice-derived transcript lines may still appear in channel summaries when they were persisted into the linked text channel, but they are context only, not a separate voice-delivery path.

## Relationship To Shared Attention

In the shared attention model:

- direct mentions and active exchanges promote Clanker into `ACTIVE`
- this ambient text cycle is the current text transport for `AMBIENT`
- the voice thought engine is the corresponding voice transport for `AMBIENT`

The transports stay different, but the behavioral intent is the same: Clanker is present, occasionally thinks of something worth surfacing, and may still choose silence.

## Settings Reference

### Initiative Text Settings

| Setting | Purpose |
|---|---|
| `initiative.text.enabled` | Master ambient-text toggle |
| `initiative.text.execution` | Execution policy for the ambient-text LLM call |
| `initiative.text.eagerness` | Probability gate before consultation |
| `initiative.text.minMinutesBetweenPosts` | Minimum spacing between ambient-text considerations |
| `initiative.text.maxPostsPerDay` | Daily ambient-text budget |
| `initiative.text.lookbackMessages` | Channel context window |
| `initiative.text.allowActiveCuriosity` | Enables `web_search` and `browser_browse` |
| `initiative.text.maxToolSteps` | Max ambient-text tool-loop steps |
| `initiative.text.maxToolCalls` | Max ambient-text tool calls |

### Discovery Infrastructure Settings

| Setting group | Purpose |
|---|---|
| `initiative.discovery.sources` | Enables source families |
| `initiative.discovery.redditSubreddits` / `rssFeeds` / `youtubeChannelIds` / `xHandles` | Feed inputs |
| `initiative.discovery.freshnessHours` / `dedupeHours` / `sourceFetchLimit` | Candidate collection behavior |
| `initiative.discovery.allowSelfCuration` / `maxSourcesPerType` | Feed-management guardrails |
| `initiative.discovery.allowImagePosts` / `allowVideoPosts` / `allowReplyGifs` etc. | Media capability switches |
| `initiative.discovery.maxImagesPerDay` / `maxVideosPerDay` / `maxGifsPerDay` | Media budgets |
| `initiative.discovery.allowedImageModels` / `allowedVideoModels` | Media allowlists |

## Memory And Community Context

The initiative prompt can include:

- durable memory facts
- always-on behavior guidance facts
- relevant behavioral memory facts
- lightweight interest facts derived from recent guild activity
- source performance summaries based on recent initiative outcomes

This keeps initiative contextual through memory-backed behavioral guidance.

## Self-Curation

When `initiative.discovery.allowSelfCuration` is enabled, the initiative tool loop may use:

- `discovery_source_add`
- `discovery_source_remove`
- `discovery_source_list`

Those tools let the model manage its own feed within operator-owned guardrails.

## Source Files

- `src/bot/initiativeEngine.ts`
- `src/services/discovery.ts`
- `src/prompts/promptText.ts`
- `src/store/settingsNormalization.ts`
- `src/bot/memorySlice.ts`
