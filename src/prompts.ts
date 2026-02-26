import {
  buildHardLimitsSection,
  getPromptBotName,
  getPromptStyle,
  PROMPT_CAPABILITY_HONESTY_LINE
} from "./promptCore.ts";

function stripEmojiForPrompt(text) {
  let value = String(text || "");
  value = value.replace(/<a?:[a-zA-Z0-9_~]+:\d+>/g, "");
  value = value.replace(/:[a-zA-Z0-9_+-]+:/g, "");
  value = value.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
  return value.replace(/\s+/g, " ").trim();
}

function formatRecentChat(messages) {
  if (!messages?.length) return "(no recent messages available)";

  return messages
    .slice()
    .reverse()
    .map((msg) => {
      const isBot = msg.is_bot === 1 || msg.is_bot === true || msg.is_bot === "1";
      const rawText = String(msg.content || "");
      const normalized = isBot ? stripEmojiForPrompt(rawText) : rawText;
      const text = normalized.replace(/\s+/g, " ").trim();
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
      const sourceId = String(index + 1);
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

function renderPromptMemoryFact(row, { includeType = true, includeProvenance = true } = {}) {
  const fact = String(row?.fact || "").replace(/\s+/g, " ").trim();
  if (!fact) return "";

  const type = String(row?.fact_type || "").trim().toLowerCase();
  const label = includeType && type && type !== "other" ? `${type}: ` : "";
  if (!includeProvenance) return `${label}${fact}`;

  const evidence = String(row?.evidence_text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  const source = String(row?.source_message_id || "").trim().slice(0, 28);
  const createdAt = String(row?.created_at || "").trim().slice(0, 10);
  const confidence = Number(row?.confidence);
  const confidenceLabel = Number.isFinite(confidence) ? ` | conf:${confidence.toFixed(2)}` : "";
  const evidenceLabel = evidence ? ` | evidence: "${evidence}"` : "";
  const sourceLabel = source ? ` | source:${source}` : "";
  const dateLabel = createdAt ? ` | date:${createdAt}` : "";

  return `${label}${fact}${evidenceLabel}${sourceLabel}${dateLabel}${confidenceLabel}`;
}

function formatMemoryFacts(facts, { includeType = true, includeProvenance = true, maxItems = 12 } = {}) {
  if (!facts?.length) return "(no durable memory hits)";

  return facts
    .slice(0, Math.max(1, Number(maxItems) || 12))
    .map((row) => {
      const rendered = renderPromptMemoryFact(row, { includeType, includeProvenance });
      return rendered ? `- ${rendered}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatMemoryLookupResults(results) {
  if (!results?.length) return "(no matching durable memory found)";
  return results
    .map((row, index) => {
      const rendered = renderPromptMemoryFact(row, { includeType: true, includeProvenance: true });
      return rendered ? `- [M${index + 1}] ${rendered}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSystemPrompt(settings) {
  const memoryEnabled = Boolean(settings?.memory?.enabled);

  return [
    `You are ${getPromptBotName(settings)}, a real-feeling regular in a Discord server.`,
    `Style: ${getPromptStyle(settings, "playful slang")}.`,
    "Write like a person in chat, not like an assistant.",
    "Use occasional slang naturally (not every sentence).",
    "Default to short messages but go longer when the conversation calls for it.",
    "Use server emoji tokens in text only when necessary and when they enhance the message.",
    PROMPT_CAPABILITY_HONESTY_LINE,
    memoryEnabled
      ? "You have persistent memory across conversations via saved durable facts and logs. Do not claim each conversation starts from zero."
      : "Persistent memory is disabled right now. Do not claim long-term memory across separate conversations.",
    "If asked to do something impossible, say it casually and suggest a text-only alternative.",
    ...buildHardLimitsSection(settings),
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
  allowReplySimpleImages = false,
  allowReplyComplexImages = false,
  remainingReplyImages = 0,
  allowReplyVideos = false,
  remainingReplyVideos = 0,
  allowReplyGifs = false,
  remainingReplyGifs = 0,
  gifRepliesEnabled = false,
  gifsConfigured = false,
  replyEagerness = 35,
  reactionEagerness = 20,
  addressing = null,
  webSearch = null,
  memoryLookup = null,
  allowWebSearchDirective = false,
  allowMemoryLookupDirective = false,
  allowMemoryDirective = false,
  voiceMode = null,
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
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: true, maxItems: 8 }));
  }

  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
  }

  if (memoryLookup?.requested) {
    if (memoryLookup.error) {
      parts.push(`Memory lookup failed: ${memoryLookup.error}`);
      parts.push("Answer from currently available context and avoid inventing memory.");
    } else if (!memoryLookup.results?.length) {
      parts.push(`Memory lookup for "${memoryLookup.query || message?.content || ""}" found no durable matches.`);
      parts.push("Say that no strong memory match was found if the user asked what you remember.");
    } else {
      parts.push(`Memory lookup results for "${memoryLookup.query || message?.content || ""}":`);
      parts.push(formatMemoryLookupResults(memoryLookup.results));
      parts.push("If useful, cite memory hits inline as [M1], [M2], etc.");
    }
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
  parts.push("If a reaction is useful, set reactionEmoji to exactly one allowed emoji. Otherwise set reactionEmoji to null.");

  const voiceEnabled = Boolean(voiceMode?.enabled);
  const voiceJoinOnTextNL = Boolean(voiceMode?.joinOnTextNL);
  if (voiceEnabled && voiceJoinOnTextNL) {
    parts.push("Voice mode is enabled right now.");
    parts.push("Do not claim you are text-only or unable to join voice channels.");
    parts.push("If users mention VC/voice requests, stay consistent with voice being available.");
    parts.push(
      "If the incoming message is clearly asking you to join, leave, or report VC status, set voiceIntent.intent to join, leave, or status."
    );
    parts.push(
      "Set voiceIntent.confidence from 0 to 1. Use high confidence only for explicit voice-control requests aimed at you."
    );
    parts.push("For normal chat or ambiguous requests, set voiceIntent.intent to none and keep confidence low.");
  } else if (voiceEnabled) {
    parts.push("Voice mode is enabled, but text-triggered NL join controls are disabled.");
    parts.push("If asked to join VC from text chat, say text triggers are currently disabled.");
    parts.push("Set voiceIntent.intent to none.");
  } else {
    parts.push("Voice mode is disabled right now.");
    parts.push("If asked to join VC, say voice mode is currently disabled.");
    parts.push("Set voiceIntent.intent to none.");
  }

  if (allowWebSearchDirective) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user explicitly asked not to use web search.");
      parts.push("Set webSearchQuery to null and do not claim live lookup.");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup is disabled in settings.");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup is unavailable (no search provider is configured).");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup is unavailable right now (hourly search budget exhausted).");
      parts.push("Set webSearchQuery to null.");
      parts.push("Do not claim you searched the web.");
    } else {
      parts.push("Live web lookup is available.");
      parts.push("Web search is supported right now.");
      parts.push("Do not claim you cannot search the web or that you are unable to browse.");
      parts.push(
        "If better accuracy depends on live web info, set webSearchQuery to a concise query."
      );
      parts.push("Use webSearchQuery only when needed and keep it under 220 characters.");
    }
  }

  if (allowMemoryLookupDirective) {
    if (!memoryLookup?.enabled) {
      parts.push("Durable memory lookup is unavailable for this turn.");
      parts.push("Set memoryLookupQuery to null.");
    } else {
      parts.push("Durable memory lookup is available for this turn.");
      parts.push(
        "If the user asks what you remember (or asks for stored facts) and current memory context is insufficient, set memoryLookupQuery to a concise lookup query."
      );
      parts.push("Use memoryLookupQuery only when needed and keep it under 220 characters.");
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
        "The user asked for a web lookup, but live search is unavailable (no search provider is configured)."
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
    parts.push(
      "Decide whether to cite sources based on the user's message and the claim sensitivity."
    );
    parts.push(
      "If citations would help (for example user asked for proof/sources or the claim is precise), use source IDs inline like [1] or [2]."
    );
    parts.push("If citations are not needed, answer naturally without citation clutter.");
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
  const remainingVideos = Math.max(0, Math.floor(Number(remainingReplyVideos) || 0));
  const simpleImageAvailable = allowReplySimpleImages && remainingImages > 0;
  const complexImageAvailable = allowReplyComplexImages && remainingImages > 0;
  const videoGenerationAvailable = allowReplyVideos && remainingVideos > 0;
  const anyVisualGeneration = simpleImageAvailable || complexImageAvailable || videoGenerationAvailable;

  if (anyVisualGeneration) {
    parts.push(
      `Visual generation is available (${remainingImages} image slot(s), ${remainingVideos} video slot(s) left where enabled in the rolling 24h budgets).`
    );
    if (simpleImageAvailable) {
      parts.push("For a simple/quick visual, set media to {\"type\":\"image_simple\",\"prompt\":\"...\"}.");
      parts.push("Use image_simple for straightforward concepts or fast meme-style visuals.");
    }
    if (complexImageAvailable) {
      parts.push("For a detailed/composition-heavy visual, set media to {\"type\":\"image_complex\",\"prompt\":\"...\"}.");
      parts.push("Use image_complex for cinematic/detail-rich scenes or harder visual requests.");
    }
    if (videoGenerationAvailable) {
      parts.push("If a generated clip is best, set media to {\"type\":\"video\",\"prompt\":\"...\"}.");
      parts.push("Use video when motion/animation is meaningfully better than a still image.");
    }
    parts.push("Keep image/video media prompts concise (under 240 chars), and always include normal reply text.");
  } else {
    parts.push("Reply image/video generation is unavailable right now. Respond with text only.");
    parts.push("Set media to null.");
  }

  const remainingGifs = Math.max(0, Math.floor(Number(remainingReplyGifs) || 0));
  if (allowReplyGifs && remainingGifs > 0) {
    parts.push(`Reply GIF lookup is available (${remainingGifs} GIF lookup(s) left in the rolling 24h budget).`);
    parts.push("GIF replies are supported right now.");
    parts.push("Do not claim you cannot send GIFs and do not claim you are text-only.");
    parts.push("If a GIF should be sent, set media to {\"type\":\"gif\",\"prompt\":\"short search query\"}.");
    parts.push("Use media.type=gif only when a reaction GIF genuinely improves the reply.");
    parts.push("Keep GIF media prompts concise (under 120 chars), and always include normal reply text.");
  } else if (gifRepliesEnabled && !gifsConfigured) {
    parts.push("Reply GIF lookup is unavailable right now (missing GIPHY configuration).");
    parts.push("Do not set media.type=gif.");
  } else if (gifRepliesEnabled) {
    parts.push("Reply GIF lookup is unavailable right now (24h GIF budget exhausted).");
    parts.push("Do not set media.type=gif.");
  }

  if (anyVisualGeneration || (allowReplyGifs && remainingGifs > 0)) {
    parts.push("Set at most one media object for this reply.");
  }

  if (allowMemoryDirective) {
    parts.push("If the incoming message contains durable info worth keeping, set memoryLine to a concise fact.");
    parts.push(
      "Use memoryLine only for lasting facts (names, preferences, recurring relationships, long-lived context), not throwaway chatter."
    );
    parts.push("Keep memoryLine concise (under 180 chars) and factual.");
  }

  parts.push("Task: write one natural Discord reply to the incoming message.");
  parts.push("Return strict JSON only. Do not output markdown or code fences.");
  parts.push("JSON format:");
  parts.push(
    "{\"text\":\"reply or [SKIP]\",\"skip\":false,\"reactionEmoji\":null,\"media\":null,\"webSearchQuery\":null,\"memoryLookupQuery\":null,\"memoryLine\":null,\"voiceIntent\":{\"intent\":\"none\",\"confidence\":0,\"reason\":null}}"
  );
  parts.push("Set skip=true only when no response should be sent. If skip=true, set text to [SKIP].");
  parts.push("When no reaction is needed, set reactionEmoji to null.");
  parts.push("When no media should be generated, set media to null.");
  parts.push("When no lookup is needed, set webSearchQuery and memoryLookupQuery to null.");
  parts.push("When no durable fact should be saved, set memoryLine to null.");
  parts.push("Set voiceIntent.intent to one of join|leave|status|none.");
  parts.push("When not issuing voice control, set voiceIntent.intent=none, voiceIntent.confidence=0, voiceIntent.reason=null.");

  return parts.join("\n\n");
}

export function buildVoiceTurnPrompt({
  speakerName = "unknown",
  transcript = "",
  userFacts = [],
  relevantFacts = [],
  isEagerTurn = false,
  voiceEagerness = 0
}) {
  const parts = [];
  const speaker = String(speakerName || "unknown").trim() || "unknown";
  const text = String(transcript || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);

  parts.push(`Incoming live voice transcript from ${speaker}: ${text || "(empty)"}`);

  if (userFacts?.length) {
    parts.push("Known facts about this user:");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: false, maxItems: 8 }));
  }

  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: false, maxItems: 8 }));
  }

  if (isEagerTurn) {
    const eagerness = Math.max(0, Math.min(100, Number(voiceEagerness) || 0));
    parts.push(`You were NOT directly addressed. You're considering whether to chime in.`);
    parts.push(`Voice reply eagerness: ${eagerness}/100.`);
    parts.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");

    parts.push("Task: respond as a natural spoken VC reply, or output exactly [SKIP] if you have nothing to add. Keep it concise by default but go longer if warranted.");
    parts.push("If responding, use plain text only. No directives, tags, or markdown.");
  } else {
    parts.push("Task: respond as a natural spoken VC reply. Keep it concise by default but go longer if warranted.");
    parts.push("Use plain text only. Do not output directives, tags, markdown, or [SKIP].");
  }

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  channelName,
  recentMessages,
  emojiHints,
  allowSimpleImagePosts,
  allowComplexImagePosts,
  allowVideoPosts,
  remainingInitiativeImages = 0,
  remainingInitiativeVideos = 0,
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
  const remainingVideos = Math.max(0, Math.floor(Number(remainingInitiativeVideos) || 0));
  const simpleImageAvailable = allowSimpleImagePosts && remainingImages > 0;
  const complexImageAvailable = allowComplexImagePosts && remainingImages > 0;
  const videoAvailable = allowVideoPosts && remainingVideos > 0;
  const anyVisualAvailable = simpleImageAvailable || complexImageAvailable || videoAvailable;

  if (anyVisualAvailable) {
    parts.push(
      "You may include visual or meme-friendly ideas in your post text; an image or short video may be generated separately."
    );
    parts.push(
      `Visual generation is available for this post (${remainingImages} image slot(s), ${remainingVideos} video slot(s) left where enabled in the rolling 24h budgets).`
    );
    if (simpleImageAvailable) {
      parts.push("For a simple/quick visual, append: [[IMAGE_PROMPT: your prompt here]]");
    }
    if (complexImageAvailable) {
      parts.push("For a detailed/composition-heavy visual, append: [[COMPLEX_IMAGE_PROMPT: your prompt here]]");
    }
    if (videoAvailable) {
      parts.push("If this post should include motion, append: [[VIDEO_PROMPT: your prompt here]]");
    }
    parts.push(
      "Keep IMAGE_PROMPT, COMPLEX_IMAGE_PROMPT, and VIDEO_PROMPT concise (under 240 chars)."
    );
    parts.push(
      "Any visual prompt must avoid visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks."
    );
    parts.push(
      "If no media is needed, output only the post text. If media is needed, output at most one media directive."
    );
  } else {
    parts.push("Image/video generation for initiative posts is unavailable right now. Output text only.");
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
  parts.push("Keep it playful, non-spammy, and slightly surprising.");
  parts.push("If there is genuinely nothing good to post, output exactly [SKIP].");

  return parts.join("\n\n");
}
