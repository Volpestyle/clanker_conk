# Voice Reply Classifier

> **Scope:** The LLM-based admission classifier that decides YES/NO for non-direct-addressed voice turns.
> Reply admission gate: [`voice-reply-orchestration-state-machine.md`](voice-reply-orchestration-state-machine.md)
> Admission policy lines: `src/prompts/voiceAdmissionPolicy.ts`

## 1. When the Classifier Runs

The classifier is the admission gate that decides whether a turn reaches generation. Its default depends on the reply path:

- **Bridge:** always on — the classifier is the only gate before generation.
- **Brain:** off by default (the generation LLM decides via `[SKIP]`), but can be toggled on via `voice.admission.mode=classifier_gate` in the dashboard.
- **Native:** not applicable — audio flows directly to the realtime model.

When enabled, it does **not** run when:

- The turn is **directly addressed** (wake word / bot name detected) — fast-path allows at `voiceReplyDecision.ts` line ~728
- The session is **stt_pipeline** — generation decides via `[SKIP]`
- The admission mode is **generation_only** — all turns flow to generation
- **Music is active** and wake latch is not armed — deterministic deny before classifier
- The turn hit a **single-participant assistant followup** fast-path (if enabled)

By the time the classifier runs, all deterministic gates have already passed. The classifier handles the ambiguous middle: non-addressed turns in active sessions.

Code: `runVoiceReplyClassifier()` in `src/voice/voiceReplyDecision.ts`

## 2. Prompt Structure

The classifier receives a single `userPrompt` (no system prompt). It is called with `temperature: 0`, `maxOutputTokens: 4`, and `reasoningEffort: "minimal"`.

The prompt uses structured YES/NO criteria up front for clear decision anchors, followed by dynamic context signals (eagerness tier, room prior, music state, recency).

### Identity and criteria

```
You are a realtime voice admission classifier for a bot named "{botName}".
getEagernessClassifierTier(normalizedEagerness),
Return exactly one token: YES or NO.

Say YES when:
- the speaker is clearly addressing the bot
- this is a direct follow-up to the bot's recent reply
- the bot is already engaged with this speaker and replying now is natural

Say NO when:
- the turn is aimed at another participant
- the turn is filler, laughter, backchannel, self-talk, or non-speech
- replying would likely interrupt side conversation
```

### Eagerness tier

Inserted immediately after the criteria. Provides the persona interpretation of the raw eagerness number (`src/prompts/voiceAdmissionPolicy.ts:getEagernessClassifierTier`).

| Range | Persona |
|---|---|
| 0 | Extremely conservative — only direct address, clear follow-ups, explicit questions |
| 1-25 | Very selective — direct address, follow-ups, clear questions; default NO for ambient |
| 26-50 | Good listener — YES when genuinely contributing, don't force into conversations |
| 51-75 | Chatty and social — YES when interesting or can add value |
| 76-100 | Full conversationalist — YES freely, only NO for non-speech or explicitly addressing another person |

### Room prior

| Condition | Line |
|---|---|
| Single-human room, no addressed-to-other | "Single-human voice-room prior: default toward engagement unless the turn is clearly non-speech, self-talk, or low-value filler." |
| Multi-human room | "Multi-human room: avoid barging in without clear conversational value." |

### Music state (conditional — only when active)

These lines are **omitted entirely** when music is not playing.

| Signal | Example |
|---|---|
| `Music active: true` | Always present when music playing |
| `Music wake latched: true/false` | Whether wake latch is armed |
| `Music wake latch expires in ms: 4200` | Only when latched + finite expiry |

### Context block

```
Participant count: {N}
Participants: {comma-separated display names}
Speaker: {current speaker name}
Transcript: "{normalized transcript}"
Voice reply eagerness: {0-100}/100
```

### Conversation recency

The recency block uses narrative framing to avoid contradictory signals. When the bot recently spoke, we frame it as an active conversation rather than showing "Bot last spoke 33s ago" alongside "Never directly addressed" — which would be contradictory and misleading.

**When `recentAssistantReply = true`:**
```
Bot last spoke {N}s ago — active conversation.
Last addressed by name {N}s ago.          # only if msSinceDirectAddress is set
```

**When `recentAssistantReply = false`:**
```
Bot has not spoken recently.
Last addressed {N}s ago.                   # if msSinceDirectAddress is set
Never directly addressed.                  # if msSinceDirectAddress is null
```

### History and decision

```
Recent attributed voice turns:
{last 6 turns, max 900 chars, with speaker names and addressing annotations}

Decision: should the bot respond right now?
```

## 3. Engagement State

The classifier's behavior is shaped by the engagement state computed in `buildVoiceConversationContext()`. Key fields:

| Field | Meaning |
|---|---|
| `engaged` | Bot considers itself in active conversation with this speaker |
| `engagedWithCurrentSpeaker` | Direct address, same user as recent direct address + recent reply, or active command thread |
| `engagementState` | `"engaged"` / `"command_only_engaged"` / `"wake_word_biased"` |
| `recentAssistantReply` | Bot spoke within `RECENT_ENGAGEMENT_WINDOW_MS` (35s) |

The engagement state determines how the recency block is framed ("active conversation" vs "has not spoken recently").

See `voiceReplyDecision.ts:buildVoiceConversationContext()` for the full computation.

