# Presence and Attention Model

> **Scope:** Canonical attention model across text and voice.
> Activity/runtime mapping: [`activity.md`](activity.md)
> Voice transport stack: [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md)

## Core Idea

Clanker has one shared attention contract per social context. Text and voice are not separate minds. They are separate transport and floor-taking systems that can carry socially relevant continuity between each other.

The canonical attention modes are:

- `ACTIVE`: Clanker is engaged in the conversation.
- `AMBIENT`: Clanker is in the room, but not actively taking the conversational floor.

That does **not** require one giant transport finite-state machine or one literal shared hub module. The important part is the product behavior: continuity can carry across surfaces when it matters, while floor-taking stays modality-specific underneath it.

![Clanker Activity Model](../diagrams/clanker-activity.png)

<!-- source: docs/diagrams/clanker-activity.mmd -->

## Shared Attention Contract

Think of the system as a lightweight shared contract plus transport-specific spokes:

- shared continuity cues decide whether Clanker is broadly `ACTIVE` or `AMBIENT`
- the **text spoke** decides how that context surfaces in text
- the **voice spoke** decides how that context surfaces in voice
- small **reflex spokes** handle narrow mechanical jobs such as interrupt safety or compact playback controls

This is a behavioral contract more than a prescribed mechanism. A few shared cues are enough as long as continuity can travel naturally and each medium keeps its own right to the floor.

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

`ACTIVE` is about attention, not forced output. While Clanker is in VC, people can still pull nearby text context into the conversation, but that does not by itself force speech or automatically promote voice attention state.

Transport-specific shape:

- in text, `ACTIVE` means new turns in the recent live thread should go straight to immediate reply evaluation
- text should judge that live thread through recent-message windows, reply structure, and conversational continuity rather than voice-style real-time timers
- in voice, `ACTIVE` means recent live-room engagement keeps turns on the immediate reply path until recency and floor signals decay

### `AMBIENT`

Clanker is present but not actively in the thread.

Behavioral meaning:

- transcript and room context continue to accumulate
- the ambient thought system may occasionally surface a thought
- surfaced thoughts are still optional and may become `[SKIP]`
- in text, ambient delivery belongs to the ambient thought loop rather than the active immediate-reply path

Ambient is the “in the room but not currently talking” state, not the “off” state.

## Promotion And Decay

Shared attention should feel like a person naturally leaning in and drifting back out.

Promotion into `ACTIVE` should come from clear social signals:

- somebody explicitly addressed Clanker
- somebody replied directly to him
- a recent exchange is still obviously ongoing
- in text, that recent exchange should be read through thread continuity and recent-message context, not a voice-style stopwatch

Decay back to `AMBIENT` should come from conversational drift:

- no recent direct address
- no recent reply from Clanker
- no active floor-taking state that keeps him engaged

This decay is a social fade, not a hard modality reset.

## Text And Voice Share The Mind, Not The Body

Text and voice should behave like two ways the same person participates:

- text decides whether to post, reply, or stay silent in channels
- voice decides whether to speak, interrupt, duck, pause, or stay silent in the room

Shared context can still travel across surfaces when somebody explicitly brings it in:

- while Clanker is in VC, someone can ask about something they sent in text and he can respond in voice or type back in chat if he wants
- a wake-word interaction in VC can make a nearby text follow-up feel like part of the same conversation when that text context is explicitly being engaged

That continuity is informative, not authoritative:

- being active in one surface does not automatically grant floor ownership in the other
- relevant context can carry across text and voice without turning every nearby room into one giant conversation

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
- reply-admission classifier, when bridge needs pre-generation silence or full brain uses optional classifier-first cost gating
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
- he can keep a pending thought around long enough to refine it, replace it, or drop it
- he may still choose silence

They differ only in delivery:

- text ambient thought surfaces as a post
- voice ambient thought surfaces as a spoken utterance
- text ambient-thought eagerness shapes this ambient surface only; it should not gate clearly active text follow-ups

Both transports now support a lightweight pending-thought queue rather than a pure one-shot draft. The queue is not a second mind or a hidden script. It is just short-lived continuity for the same ambient attention surface:

- `Your current thought: ...`
- re-check the room
- decide whether to surface it now, keep it for later, or let it go

The shared design goal is one ambient attention model with multiple transports, not two unrelated “initiative engines.”

## Relationship To The Current Runtime

This document is the canonical behavioral model.

Current implementation is intentionally distributed across several systems rather than one literal shared module:

- text reply admission and recent windows
- text initiative
- voice reply admission and wake/direct-address handling, including bridge-required and optional full-brain classifier-first cost gates
- voice thought generation
- music wake latch and floor-control overlays

That distribution is acceptable as long as the product contract holds:

- relevant continuity can carry across text and voice
- text and voice still keep their own floor-taking rules
- docs keep describing one bot rather than two separate modality-specific minds

Product language: Clanker should feel like one person whose attention can shift across text and voice, while each medium still follows its own natural floor-taking rules.
