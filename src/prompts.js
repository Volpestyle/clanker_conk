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

function formatWebSearchFindings(webSearch) {
  if (!webSearch?.results?.length) return "(no web results available)";

  return webSearch.results
    .map((item, index) => {
      const sourceId = `S${index + 1}`;
      const title = String(item.title || "untitled").trim();
      const url = String(item.url || "").trim();
      const domain = String(item.domain || "").trim();
      const snippet = String(item.snippet || "").trim();
      const pageSummary = String(item.pageSummary || "").trim();
      const pageLine = pageSummary ? ` | page: ${pageSummary}` : "";
      const snippetLine = snippet ? ` | snippet: ${snippet}` : "";
      const domainLabel = domain ? ` (${domain})` : "";
      return `- [${sourceId}] ${title}${domainLabel} -> ${url}${snippetLine}${pageLine}`;
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
  emojiHints,
  allowReplyImages = false,
  remainingReplyImages = 0,
  userRequestedImage = false,
  webSearch = null
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

  if (webSearch?.requested && !webSearch.used) {
    if (!webSearch.configured) {
      parts.push(
        "The user asked for a web lookup, but live search is unavailable (missing Google search configuration)."
      );
      parts.push("Acknowledge briefly and answer from known context only.");
    } else if (webSearch.blockedByBudget) {
      parts.push("The user asked for a web lookup, but the hourly search budget is exhausted.");
      parts.push("Acknowledge the limit briefly and answer without claiming live lookup.");
    } else if (webSearch.error) {
      parts.push(`The web lookup failed: ${webSearch.error}`);
      parts.push("Do not claim you successfully searched the web.");
    } else if (!webSearch.results?.length) {
      parts.push("A web lookup was attempted, but no useful results were found.");
      parts.push("Answer carefully and avoid invented specifics.");
    }
  }

  if (webSearch?.used && webSearch.results?.length) {
    parts.push(`Live web findings for query: "${webSearch.query}"`);
    parts.push(formatWebSearchFindings(webSearch));
    parts.push("If you reference web facts, cite source IDs inline like [S1] or [S2].");
  }

  const remainingImages = Math.max(0, Math.floor(Number(remainingReplyImages) || 0));
  if (allowReplyImages && remainingImages > 0) {
    parts.push(
      `Reply image generation is available (${remainingImages} image slot(s) left in the rolling 24h budget).`
    );
    parts.push(
      "If an image should be generated, append one final line exactly in this format: [[IMAGE_PROMPT: your prompt here]]"
    );
    parts.push(
      "Use IMAGE_PROMPT only when the user explicitly asks for an image or a visual is clearly the best response."
    );
    if (userRequestedImage) {
      parts.push("The user explicitly asked for an image. Include IMAGE_PROMPT unless unsafe or disallowed.");
    }
    parts.push("Keep IMAGE_PROMPT concise (under 240 chars), and always include normal reply text.");
  } else {
    parts.push("Reply image generation is unavailable right now. Respond with text only.");
    if (userRequestedImage) {
      parts.push("The user asked for an image. Briefly acknowledge the limit in your text reply.");
    }
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
