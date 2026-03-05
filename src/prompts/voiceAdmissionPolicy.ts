type VoiceAdmissionPolicyMode = "generation" | "classifier";

type VoiceAdmissionPolicyContext = {
  engaged?: boolean;
  engagedWithCurrentSpeaker?: boolean;
};

type VoiceAdmissionPolicyOptions = {
  mode?: VoiceAdmissionPolicyMode;
  directAddressed?: boolean;
  isEagerTurn?: boolean;
  replyEagerness?: number;
  participantCount?: number;
  conversationContext?: VoiceAdmissionPolicyContext | null;
  addressedToOtherSignal?: boolean;
  pendingCommandFollowupSignal?: boolean;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
};

export function buildVoiceAdmissionPolicyLines({
  mode = "generation",
  directAddressed = false,
  isEagerTurn = false,
  replyEagerness = 0,
  participantCount = 0,
  conversationContext = null,
  addressedToOtherSignal = false,
  pendingCommandFollowupSignal = false,
  musicActive = false,
  musicWakeLatched = false
}: VoiceAdmissionPolicyOptions = {}) {
  const lines: string[] = [];
  const normalizedMode: VoiceAdmissionPolicyMode = mode === "classifier" ? "classifier" : "generation";
  const normalizedDirectAddressed = Boolean(directAddressed);
  const normalizedIsEagerTurn = Boolean(isEagerTurn);
  const normalizedParticipantCount = Math.max(0, Math.floor(Number(participantCount) || 0));
  const normalizedEagerness = Math.max(0, Math.min(100, Number(replyEagerness) || 0));
  const engagedWithCurrentSpeaker = Boolean(conversationContext?.engagedWithCurrentSpeaker);
  const engaged = Boolean(conversationContext?.engaged);

  lines.push(`Voice reply eagerness: ${normalizedEagerness}/100.`);

  if (normalizedParticipantCount <= 1 && !addressedToOtherSignal) {
    lines.push("Single-human voice-room prior: default toward engagement unless the turn is clearly non-speech, self-talk, or low-value filler.");
  } else if (normalizedParticipantCount > 1) {
    lines.push("Multi-human room: avoid barging in without clear conversational value.");
  }

  if (musicActive) {
    lines.push("Music is currently active.");
    if (musicWakeLatched || normalizedDirectAddressed) {
      lines.push("Music wake latch is active for follow-ups, so no repeated wake word is required right now.");
    } else {
      lines.push("Music wake latch is not active; non-wake chatter during music should be denied.");
    }
  }

  if (pendingCommandFollowupSignal) {
    lines.push("Signal: this may be a same-speaker command follow-up. Treat as a strong positive context signal and prefer YES unless the transcript is unusable.");
  }

  if (addressedToOtherSignal) {
    lines.push("Signal: this may be directed to another participant. Treat as a strong negative context signal; in ambiguous cases, prefer NO.");
  }

  if (normalizedMode === "classifier") {
    if (normalizedDirectAddressed) {
      lines.push("The turn appears directly addressed to the bot. Prefer YES unless content is unusable.");
    } else if (normalizedIsEagerTurn || engaged || engagedWithCurrentSpeaker) {
      lines.push("The bot may chime in if useful. Prefer YES when the turn is a clear continuation, direct question, or socially natural check-in.");
    } else {
      lines.push("The bot should stay selective. Prefer NO when this appears to be side chatter, filler, or not meant for the bot.");
    }
    if (addressedToOtherSignal) {
      lines.push("When target likely equals OTHER and there is no clear handoff to the bot, prefer NO.");
    }
    lines.push("If the turn is only laughter/backchannel noise with no clear ask, prefer NO.");
    return lines;
  }

  if (normalizedIsEagerTurn) {
    lines.push("You were NOT directly addressed. You're considering whether to chime in.");
    if (engagedWithCurrentSpeaker) {
      lines.push("You are actively in this speaker's thread. Lean toward a short helpful reply over [SKIP].");
    }
    lines.push(
      "If the turn is only laughter, filler, or backchannel noise (for example haha, lol, hmm, mm, uh-huh, yup), strongly prefer [SKIP] unless there is a clear question, request, or obvious conversational value in replying."
    );
    lines.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");
    lines.push("Task: respond as a natural spoken VC reply, or skip if you have nothing to add.");
    return lines;
  }

  if (!normalizedDirectAddressed) {
    lines.push(
      "If the turn is only laughter, filler, or backchannel noise with no clear ask or meaningful new content, prefer [SKIP]."
    );
    lines.push("Task: decide whether to respond now or output [SKIP] if a reply would be interruptive, low-value, or likely not meant for you.");
    return lines;
  }

  lines.push("Task: respond as a natural spoken VC reply.");
  return lines;
}
