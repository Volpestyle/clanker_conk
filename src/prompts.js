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

function formatVideoFindings(videoContext) {
  if (!videoContext?.videos?.length) return "(no video context available)";

  return videoContext.videos
    .map((item, index) => {
      const sourceId = `V${index + 1}`;
      const provider = String(item.provider || item.kind || "video").trim();
      const title = String(item.title || "untitled video").trim();
      const channel = String(item.channel || "unknown channel").trim();
      const url = String(item.url || "").trim();
      const description = String(item.description || "").trim();
      const transcript = String(item.transcript || "").trim();
      const transcriptSource = String(item.transcriptSource || "").trim();
      const keyframeCount = Number(item.keyframeCount);
      const publishedAt = String(item.publishedAt || "").trim();
      const durationSeconds = Number(item.durationSeconds);
      const durationLabel = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? ` | duration: ${durationSeconds}s`
        : "";
      const publishedLabel = publishedAt ? ` | published: ${publishedAt}` : "";
      const summaryLabel = description ? ` | summary: ${description}` : "";
      const transcriptSourceLabel = transcriptSource ? ` | transcript_source: ${transcriptSource}` : "";
      const transcriptLabel = transcript ? ` | transcript: ${transcript}` : "";
      const keyframeLabel = Number.isFinite(keyframeCount) && keyframeCount > 0 ? ` | keyframes: ${keyframeCount}` : "";
      return `- [${sourceId}] (${provider}) ${title} by ${channel} -> ${url}${durationLabel}${publishedLabel}${summaryLabel}${transcriptSourceLabel}${transcriptLabel}${keyframeLabel}`;
    })
    .join("\n");
}

function formatMemoryFacts(facts) {
  if (!facts?.length) return "(no durable memory hits)";

  return facts
    .map((row) => {
      const fact = String(row?.fact || "").replace(/\s+/g, " ").trim();
      if (!fact) return "";
      const type = String(row?.fact_type || "").trim().toLowerCase();
      const label = type && type !== "other" ? `${type}: ` : "";
      return `- ${label}${fact}`;
    })
    .filter(Boolean)
    .join("\n");
}

function looksLikeDirectWebSearchCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const hasSearchVerb = /\b(?:google|search|look\s*up|lookup|find)\b/i.test(raw);
  if (!hasSearchVerb) return false;

  if (/^(?:<@!?\d+>\s*)?(?:google|search|look\s*up|lookup|find)\b/i.test(raw)) return true;
  if (/\bclank(?:er|a|s)\b/i.test(raw)) return true;
  if (/\b(?:can|could|would|will)\s+(?:you|u)\b/i.test(raw)) return true;

  return false;
}

export function buildSystemPrompt(settings) {
  const hardLimits = settings.persona?.hardLimits ?? [];

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
    "If you should not send a message, output exactly [SKIP]."
  ].join("\n");
}

export function buildReplyPrompt({
  message,
  imageInputs,
  recentMessages,
  relevantMessages,
  userFacts,
  relevantFacts,
  emojiHints,
  reactionEmojiOptions = [],
  allowReplyImages = false,
  remainingReplyImages = 0,
  allowReplyGifs = false,
  remainingReplyGifs = 0,
  gifRepliesEnabled = false,
  gifsConfigured = false,
  userRequestedImage = false,
  replyEagerness = 35,
  reactionEagerness = 20,
  addressing = null,
  webSearch = null,
  allowWebSearchDirective = false,
  allowMemoryDirective = false,
  videoContext = null
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

  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts));
  }

  if (emojiHints?.length) {
    parts.push(`Server emoji options: ${emojiHints.join(", ")}`);
  }
  if (reactionEmojiOptions?.length) {
    parts.push("Allowed reaction emojis (use exactly one if reacting):");
    parts.push(formatEmojiChoices(reactionEmojiOptions));
  }

  const directlyAddressed = Boolean(addressing?.directlyAddressed);
  const responseRequired = Boolean(addressing?.responseRequired);
  if (directlyAddressed) {
    parts.push("This message directly addressed you.");
  }
  if (responseRequired) {
    parts.push("A reply is required for this turn unless safety policy requires refusing.");
    parts.push("Do not output [SKIP] except for safety refusals.");
  } else {
    const eagerness = Math.max(0, Math.min(100, Number(replyEagerness) || 0));
    parts.push(`Reply eagerness setting: ${eagerness}/100.`);
    if (eagerness <= 25) {
      parts.push("Be very selective and skip unless a reply is clearly useful.");
    } else if (eagerness >= 75) {
      parts.push("Be more willing to jump in when it improves the chat.");
    } else {
      parts.push("Use balanced judgment before joining the conversation.");
    }
    parts.push("Decide if replying adds value right now.");
    parts.push(
      "If this message is not really meant for you or would interrupt people talking among themselves, output exactly [SKIP]."
    );
  }

  const reactionLevel = Math.max(0, Math.min(100, Number(reactionEagerness) || 0));
  parts.push(`Reaction eagerness setting: ${reactionLevel}/100.`);
  if (reactionLevel <= 25) {
    parts.push("React sparingly and only when it clearly adds social value.");
  } else if (reactionLevel >= 75) {
    parts.push("You can react more often, but only when it naturally fits the tone.");
  } else {
    parts.push("Use balanced judgment for reactions.");
  }
  parts.push(
    "If a reaction is useful, append one final line exactly in this format: [[REACTION: emoji]]."
  );
  parts.push("Use only one emoji from the allowed reaction list.");
  parts.push("If no reaction is needed, do not output REACTION.");

  if (allowWebSearchDirective) {
    const directCommand = looksLikeDirectWebSearchCommand(message?.content);
    if (webSearch?.optedOutByUser) {
      parts.push("The user explicitly asked not to use web search.");
      parts.push("Do not request WEB_SEARCH and do not claim live lookup.");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup is disabled in settings.");
      parts.push("Do not claim you searched the web.");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup is unavailable (missing Google search configuration).");
      parts.push("Do not claim you searched the web.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup is unavailable right now (hourly search budget exhausted).");
      parts.push("Do not claim you searched the web.");
    } else {
      parts.push("Live web lookup is available.");
      parts.push("Web search is supported right now.");
      parts.push("Do not claim you cannot search the web or that you are unable to browse.");
      if (directCommand) {
        parts.push("The incoming message is a direct command to search the web.");
        parts.push(
          "For this turn, request WEB_SEARCH unless the request is unsafe, disallowed, or impossible."
        );
      }
      parts.push(
        "If better accuracy depends on live web info, append one final line exactly in this format: [[WEB_SEARCH: concise query]]"
      );
      parts.push("Use WEB_SEARCH only when needed and keep the query under 220 characters.");
    }
  }

  if (webSearch?.requested && !webSearch.used) {
    if (webSearch.optedOutByUser) {
      parts.push("The user asked not to use web search. Respond without web lookup.");
    } else if (!webSearch.enabled) {
      parts.push("A web lookup was requested, but live search is disabled in settings.");
      parts.push("Acknowledge briefly and answer from known context only.");
    } else if (!webSearch.configured) {
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

  if (videoContext?.requested && !videoContext.used) {
    if (!videoContext.enabled) {
      parts.push("Video link understanding is disabled in settings.");
    } else if (videoContext.blockedByBudget || !videoContext.budget?.canLookup) {
      parts.push("Video link understanding is unavailable right now (hourly video context budget exhausted).");
    } else if (videoContext.error) {
      parts.push(`Video link context fetch failed: ${videoContext.error}`);
    } else {
      parts.push("Video links/attachments were detected, but no usable metadata/transcript was extracted.");
    }
    parts.push("Do not claim you watched or fully understood the video when context is missing.");
  }

  if (videoContext?.used && videoContext.videos?.length) {
    parts.push("Video context from linked or embedded videos:");
    parts.push(formatVideoFindings(videoContext));
    parts.push("If you reference video details, cite source IDs inline like [V1] or [V2].");
    parts.push("Treat transcripts and keyframes as partial context. Avoid overclaiming what happened in the full video.");
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

  const remainingGifs = Math.max(0, Math.floor(Number(remainingReplyGifs) || 0));
  if (allowReplyGifs && remainingGifs > 0) {
    parts.push(`Reply GIF lookup is available (${remainingGifs} GIF lookup(s) left in the rolling 24h budget).`);
    parts.push("GIF replies are supported right now.");
    parts.push("Do not claim you cannot send GIFs and do not claim you are text-only.");
    parts.push(
      "If a GIF should be sent, append one final line exactly in this format: [[GIF_QUERY: short search query]]"
    );
    parts.push("Use GIF_QUERY only when a reaction GIF genuinely improves the reply.");
    parts.push("Keep GIF_QUERY concise (under 120 chars), and always include normal reply text.");
  } else if (gifRepliesEnabled && !gifsConfigured) {
    parts.push("Reply GIF lookup is unavailable right now (missing GIPHY configuration).");
    parts.push("Do not output GIF_QUERY.");
  } else if (gifRepliesEnabled) {
    parts.push("Reply GIF lookup is unavailable right now (24h GIF budget exhausted).");
    parts.push("Do not output GIF_QUERY.");
  }

  if ((allowReplyImages && remainingImages > 0) || (allowReplyGifs && remainingGifs > 0)) {
    parts.push("If you use media directives, output at most one: IMAGE_PROMPT or GIF_QUERY.");
  }

  if (allowMemoryDirective) {
    parts.push(
      "If the incoming message contains durable info worth keeping, append one final line exactly in this format: [[MEMORY_LINE: concise memory line]]"
    );
    parts.push(
      "Use MEMORY_LINE only for lasting facts (names, preferences, recurring relationships, long-lived context), not throwaway chatter."
    );
    parts.push("Keep MEMORY_LINE concise (under 180 chars) and factual.");
  }

  parts.push("Task: write one natural Discord reply to the incoming message.");
  parts.push("You may output both a normal reply and REACTION directive, or [SKIP] with optional REACTION.");
  parts.push("If no response is needed, output exactly [SKIP].");

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  channelName,
  recentMessages,
  emojiHints,
  allowImagePosts,
  remainingInitiativeImages = 0,
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

  const remainingImages = Math.max(0, Math.floor(Number(remainingInitiativeImages) || 0));
  if (allowImagePosts && remainingImages > 0) {
    parts.push(
      "You may include visual or meme-friendly ideas in your post text; an image may be generated separately."
    );
    parts.push(
      `Image generation is available for this post (${remainingImages} image slot(s) left in the rolling 24h budget).`
    );
    parts.push(
      "Decide yourself whether this post should include an image. If yes, append one final line exactly in this format: [[IMAGE_PROMPT: your prompt here]]"
    );
    parts.push("If no image is needed, output only the post text.");
    parts.push("Keep IMAGE_PROMPT concise (under 240 chars).");
    parts.push(
      "IMAGE_PROMPT must describe a visual only: no visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks."
    );
  } else if (allowImagePosts) {
    parts.push("Image generation is currently unavailable (24h image budget exhausted). Output text only.");
  } else {
    parts.push("Image generation for initiative posts is disabled. Output text only.");
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
