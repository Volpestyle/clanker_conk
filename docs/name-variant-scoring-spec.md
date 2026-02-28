# Name-Variant Scoring Spec

This document specifies the deterministic scorer used to detect `<name-ish>` tokens in user messages for reply admission.

## Goal

Admit likely bot-directed messages without paying for a full LLM call on every message, while still allowing the LLM to make the final conversational decision.

The scorer is:

- deterministic
- cheap to run per message
- adaptable to any runtime `settings.botName`
- conservative against obvious false positives

## Scope

The scorer is implemented in `src/addressingNameVariants.ts` and consumed by `src/bot/replyAdmission.ts`.

It does not generate replies. It only influences whether we run the normal reply LLM path.

## Inputs

- transcript/message text
- configured bot name (`settings.botName`)

Both are normalized to lowercase, accent-stripped tokens (`NFKD` + mark removal + alnum tokenization).

## Scoring Model

### 1) Base token similarity

For each token in the message, score similarity against the primary bot-name token (longest non-generic token from bot name).

Base components:

- normalized Levenshtein similarity
- consonant overlap ratio
- prefix match (first 2 chars)
- phonetic-tail match (Soundex-like map)
- hard-anchor match (`k/q/x/z/j`)
- extra boost for strong consonant overlap + hard anchor

If token stem equals bot-name stem (e.g. `clank` vs `clanker`), use a high base score directly.

If primary token has hard anchors but candidate lacks them, cap base score to reduce false positives like `cleaner`.

### 2) Context boosts

Context boosts are applied to the best candidate token:

- nearby supporting secondary bot-name token (e.g. `blinker conk`)
- wake-call shapes:
  - `yo <name-ish>`
  - `is that you <name-ish>`
  - `did i just hear a <name-ish>`
  - affection pattern (`love ... <name-ish>`)
- voice-command shape:
  - message contains both action token (`join/hop/get/...`) and VC context token (`vc/voice/channel/...`)
  - candidate token appears near the command tokens

### 3) Final decision

- choose highest-scoring candidate token
- match if score >= `NAME_VARIANT_MATCH_THRESHOLD` (`0.78`)

The scorer exposes:

- `matched` boolean
- final score and threshold
- matched token/index
- activated signals for debugging/tests

## Admission and LLM Interaction

When scorer matches, reply admission marks the message as address-triggered (`reason = name_variant`) so the normal reply LLM path runs.

Important behavior:

- `name_variant` matches do **not** force a reply
- they force **admission to LLM decision**, not deterministic output
- explicit/direct signals can still force response when appropriate

This keeps fuzzy matches cheap and robust, while letting the LLM reject edge cases where token similarity was incidental.

## Tunable Constants

Key constants live in `src/addressingNameVariants.ts`:

- base threshold and score caps
- context boosts
- voice-command shape distances
- token classes (greetings, command tokens, generic/non-name tokens)

Tune with existing tests and production logs; avoid adding hardcoded per-bot aliases.

## Test Strategy

Use existing tests and extend with fuzzy command and guardrail cases:

- `src/addressingNameVariants.test.ts`
- `src/bot/replyAdmission.test.ts`

Focus on:

- positives: `join vc clink`, `clank join vc`, callout shapes
- negatives: `join vc prank`, `Hi cleaner`, generic prose with similar tokens
- admission behavior: fuzzy match admits LLM path but does not hard-force response
