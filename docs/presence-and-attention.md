# Presence and Attention Model

> **Scope:** Canonical attention model across text and voice.
> Activity/runtime mapping: [`clanker-activity.md`](clanker-activity.md)
> Voice transport stack: [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md)

## Core Idea

Clanker has one shared attention layer per social context. Text and voice are not separate minds. They are separate transport and floor-taking systems that feed the same attention state.

The canonical attention modes are:

- `ACTIVE`: Clanker is engaged in the conversation.
- `AMBIENT`: Clanker is in the room, but not actively taking the conversational floor.

That does **not** mean one giant transport finite-state machine. The shared layer is the social mind. Text posting, voice capture, barge-in, TTS buffering, and music playback stay modality-specific underneath it.

![Clanker Activity Model](diagrams/clanker-activity.png)

<!-- source: docs/diagrams/clanker-activity.mmd -->

## Shared Attention Hub

Think of the system as hub and spoke:

- the **attention hub** decides whether Clanker is actively engaged or ambient
- the **text spoke** decides how that attention surfaces in text
- the **voice spoke** decides how that attention surfaces in voice
- small **reflex spokes** handle narrow mechanical jobs such as interrupt safety or compact playback controls

The hub is shared. The spokes stay transport-specific.

## Canonical Modes

### `ACTIVE`

Clanker is conversationally engaged.

Typical promotion paths:

- direct text mention
- reply to a bot message
- configured bot-name/alias mention
- voice wake word / bot-name direct address
- recent engaged follow-up window

Behavioral meaning:

- real conversational turns go to the main brain
- the model can still choose `[SKIP]`
- tools, memory, and personality all stay available

`ACTIVE` is about attention, not forced output. A chat ping while VC is active can make Clanker more attentive to the room without forcing immediate speech in voice.

### `AMBIENT`

Clanker is present but not actively in the thread.

Behavioral meaning:

- transcript and room context continue to accumulate
- the ambient thought system may occasionally surface a thought
- surfaced thoughts are still optional and may become `[SKIP]`

Ambient is the “in the room but not currently talking” state, not the “off” state.

## Promotion And Decay

Shared attention should feel like a person naturally leaning in and drifting back out.

Promotion into `ACTIVE` should come from clear social signals:

- somebody explicitly addressed Clanker
- somebody replied directly to him
- a recent exchange is still obviously ongoing

Decay back to `AMBIENT` should come from conversational drift:

- no recent direct address
- no recent reply from Clanker
- no active floor-taking state that keeps him engaged

This decay is a social fade, not a hard modality reset.

## Text And Voice Share The Mind, Not The Body

Text and voice should behave like two ways the same person participates:

- text decides whether to post, reply, or stay silent in channels
- voice decides whether to speak, interrupt, duck, pause, or stay silent in the room

Shared attention means cross-modal influence is real:

- a text ping can promote attention while a voice session is active
- a wake-word interaction in VC can make a nearby text follow-up feel like part of the same conversation

But output remains modality-specific:

- text does not automatically become voice
- voice does not automatically become text
- each modality still obeys its own floor, transport, and permission rules

## Orthogonal Overlays

Some runtime states are important, but they are not attention modes:

- assistant speaking
- music playing
- wake latch open
- owned tool followup pending
- interrupted-reply recovery active

These are overlays on top of `ACTIVE` / `AMBIENT`.

Example:

- music playing is not a third attention mode
- Clanker can be `AMBIENT` while music is playing
- Clanker can be `ACTIVE` while music is playing

Music changes what kind of floor-taking is natural. It does not create a different mind.

## Reflex Layers

Small-model or deterministic reflexes still fit this design, but only for narrow mechanical work:

- wake-word / alias matching
- acoustic barge-in safety
- interrupt classifier during overlap
- compact playback controls during music, when the dedicated music brain is enabled

These reflexes do not replace the main conversational brain. They only decide whether something is a real interrupt, a real playback control, or obvious noise.

The main brain still owns:

- whether to answer
- whether to `[SKIP]`
- whether to take the floor
- whether to pause, duck, or ignore music when it is asked to respond

## Ambient Thought Surface

Text initiative and voice thought generation are the same behavioral concept:

- Clanker is ambient
- he accumulates room context
- he periodically considers whether he has something worth surfacing
- he may still choose silence

They differ only in delivery:

- text ambient thought surfaces as a post
- voice ambient thought surfaces as a spoken utterance

The shared design goal is one ambient attention model with multiple transports, not two unrelated “initiative engines.”

## Relationship To The Current Runtime

This document is the canonical behavioral model.

Current implementation is still distributed across several systems rather than one literal shared module:

- text reply admission and recent windows
- text initiative
- voice reply admission and wake/direct-address handling
- voice thought generation
- music wake latch and floor-control overlays

That distribution is acceptable as long as the docs and product behavior keep converging on one shared attention model instead of two separate bots.

Product language: Clanker should feel like one person whose attention can shift across text and voice, while each medium still follows its own natural floor-taking rules.
