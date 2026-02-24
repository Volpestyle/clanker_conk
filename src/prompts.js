function formatRecentChat(messages) {
  if (!messages?.length) return "(no recent messages available)";

  return messages
    .slice()
    .reverse()
    .map((msg) => {
      const text = String(msg.content || "").replace(/\s+/g, " ").trim();
      return `- ${msg.author_name}: ${text || "(empty)"}`;
    })
    .join("\n");
}

export function buildSystemPrompt(settings, memoryMarkdown) {
  const hardLimits = settings.persona?.hardLimits ?? [];
  const trimmedMemory = (memoryMarkdown || "(memory unavailable)").slice(0, 7000);

  return [
    `You are ${settings.botName}, a real-feeling regular in a Discord server.`,
    `Style: ${settings.persona?.flavor || "playful slang"}.`,
    "Write like a person in chat, not like an assistant.",
    "Use occasional slang naturally (not every sentence).",
    "Use short messages by default (1-3 lines).",
    "You may use server emoji tokens like <:name:id> when relevant.",
    "Do not fake actions or capabilities.",
    "If asked to do something impossible, say it casually and suggest a text-only alternative.",
    "Hard limitations:",
    ...hardLimits.map((line) => `- ${line}`),
    "Safety:",
    "- No harassment, hate, sexual content with minors, or illegal instructions.",
    "- Keep tone friendly and fun.",
    "If you should not send a message, output exactly [SKIP].",
    "Memory snapshot:",
    trimmedMemory
  ].join("\n");
}

export function buildReplyPrompt({ message, recentMessages, relevantMessages, userFacts, emojiHints }) {
  const parts = [];

  parts.push(`Incoming message from ${message.authorName}: ${message.content}`);
  parts.push("Recent channel messages:");
  parts.push(formatRecentChat(recentMessages));

  if (relevantMessages?.length) {
    parts.push("Relevant past messages:");
    parts.push(formatRecentChat(relevantMessages));
  }

  if (userFacts?.length) {
    parts.push("Known facts about this user:");
    for (const fact of userFacts) {
      parts.push(`- ${fact.fact}`);
    }
  }

  if (emojiHints?.length) {
    parts.push(`Server emoji options: ${emojiHints.join(", ")}`);
  }

  parts.push("Task: write one natural Discord reply to the incoming message.");
  parts.push("If no response is needed, output exactly [SKIP].");

  return parts.join("\n\n");
}
