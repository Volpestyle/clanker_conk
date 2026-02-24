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

function formatEmojiChoices(emojiOptions) {
  if (!emojiOptions?.length) return "(no emoji options available)";
  return emojiOptions.map((emoji) => `- ${emoji}`).join("\n");
}

function formatDiscoveryFindings(findings) {
  if (!findings?.length) return "(no fresh links found)";

  return findings
    .map((item) => {
      const source = item.sourceLabel || item.source || "web";
      const title = String(item.title || "untitled").trim();
      const url = String(item.url || "").trim();
      const excerpt = String(item.excerpt || "").trim();
      const excerptLine = excerpt ? ` | ${excerpt}` : "";
      return `- [${source}] ${title} -> ${url}${excerptLine}`;
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

export function buildReplyPrompt({
  message,
  imageInputs,
  recentMessages,
  relevantMessages,
  userFacts,
  emojiHints
}) {
  const parts = [];

  parts.push(`Incoming message from ${message.authorName}: ${message.content}`);
  if (imageInputs?.length) {
    parts.push(
      [
        "Incoming image attachments:",
        ...imageInputs.map((image) => {
          const name = image.filename || "(unnamed)";
          const type = image.contentType || "unknown";
          return `- ${name} (${type})`;
        })
      ].join("\n")
    );
  }
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

export function buildInitiativePrompt({
  channelName,
  recentMessages,
  emojiHints,
  allowImagePosts,
  discoveryFindings = [],
  maxLinksPerPost = 2,
  requireDiscoveryLink = false
}) {
  const parts = [];

  parts.push(
    `You are posting proactively in #${channelName}. No one directly asked you to respond.`
  );
  parts.push("Recent channel messages:");
  parts.push(formatRecentChat(recentMessages));

  if (emojiHints?.length) {
    parts.push(`Server emoji options: ${emojiHints.join(", ")}`);
  }

  if (allowImagePosts) {
    parts.push(
      "You may include visual or meme-friendly ideas in your post text; an image may be generated separately."
    );
  }

  if (discoveryFindings?.length) {
    parts.push("Fresh external findings (optional inspiration):");
    parts.push(formatDiscoveryFindings(discoveryFindings));
    parts.push(
      `If you include links, use URLs exactly as listed above and keep it to at most ${maxLinksPerPost} links.`
    );
    if (requireDiscoveryLink) {
      parts.push(
        "Include at least one of the listed URLs if possible. If none fit naturally, output exactly [SKIP]."
      );
    }
  }

  parts.push("Task: write one standalone Discord message that feels timely and human.");
  parts.push("Keep it short (1-3 lines), playful, non-spammy, and slightly surprising.");
  parts.push("If there is genuinely nothing good to post, output exactly [SKIP].");

  return parts.join("\n\n");
}

export function buildReactionPrompt({
  message,
  recentMessages,
  emojiOptions,
  reactionLevel
}) {
  const parts = [];
  const content = String(message.content || "").trim() || "(empty message)";

  parts.push(`Incoming message from ${message.authorName}: ${content}`);
  if (Number(message.attachmentCount || 0) > 0) {
    parts.push(`Incoming message has ${message.attachmentCount} attachment(s).`);
  }

  parts.push("Recent channel messages:");
  parts.push(formatRecentChat(recentMessages));

  parts.push("Allowed reaction emojis (choose exactly one from this list if reacting):");
  parts.push(formatEmojiChoices(emojiOptions));

  parts.push(`Reaction eagerness setting: ${reactionLevel}/100`);
  parts.push("Task: decide whether to react to the incoming message.");
  parts.push("Return JSON only with this schema:");
  parts.push(
    '{"shouldReact": boolean, "emoji": string|null, "confidence": number, "reason": string}'
  );
  parts.push("Set confidence from 0 to 1.");
  parts.push("If shouldReact is false, set emoji to null.");
  parts.push("Do not output any text outside JSON.");

  return parts.join("\n\n");
}
