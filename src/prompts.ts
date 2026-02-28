import {
  buildHardLimitsSection,
  buildVoiceToneGuardrails,
  getMediaPromptCraftGuidance,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptSkipLine,
  getPromptStyle,
  getPromptTextGuidance
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

function formatImageLookupCandidates(candidates) {
  if (!candidates?.length) return "(no recent image references found)";
  return candidates
    .slice(0, 12)
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = String(row?.createdAt || "").trim();
      const context = String(row?.context || "").trim();
      const whenLabel = when ? ` at ${when}` : "";
      const contextLabel = context ? ` | context: ${context}` : "";
      return `- [I${index + 1}] ${filename} by ${author}${whenLabel}${contextLabel}`;
    })
    .join("\n");
}

function formatImageLookupResults(results) {
  if (!results?.length) return "(no matching history images found)";
  return results
    .map((row, index) => {
      const filename = String(row?.filename || "(unnamed)").trim();
      const author = String(row?.authorName || "unknown").trim();
      const when = String(row?.createdAt || "").trim();
      const reason = String(row?.matchReason || "").trim();
      const whenLabel = when ? ` at ${when}` : "";
      const reasonLabel = reason ? ` | match: ${reason}` : "";
      return `- [I${index + 1}] ${filename} by ${author}${whenLabel}${reasonLabel}`;
    })
    .join("\n");
}

export function buildSystemPrompt(settings) {
  const memoryEnabled = Boolean(settings?.memory?.enabled);
  const textGuidance = getPromptTextGuidance(settings, [
    "Write like a person in chat, not like an assistant.",
    "Use occasional slang naturally (not every sentence).",
    "You're chill, but eager to be helpful whenever it makes sense.",
    "Default to short messages but go longer when the conversation calls for it.",
    "Use server emoji tokens in text only when necessary and when they enhance the message."
  ]);

  return [
    `You are ${getPromptBotName(settings)}, a real-feeling regular in a Discord server.`,
    `Style: ${getPromptStyle(settings, "playful slang")}.`,
    ...textGuidance,
    getPromptCapabilityHonestyLine(settings),
    memoryEnabled
      ? getPromptMemoryEnabledLine(settings)
      : getPromptMemoryDisabledLine(settings),
    getPromptImpossibleActionLine(settings),
    ...buildHardLimitsSection(settings),
    getPromptSkipLine(settings)
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
  imageLookup = null,
  allowWebSearchDirective = false,
  allowMemoryLookupDirective = false,
  allowImageLookupDirective = false,
  allowMemoryDirective = false,
  allowAutomationDirective = false,
  automationTimeZoneLabel = "",
  voiceMode = null,
  screenShare = null,
  videoContext = null,
  channelMode = "non_initiative",
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);
  const normalizedChannelMode = channelMode === "initiative" ? "initiative" : "non_initiative";

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
      parts.push("Reference memory naturally without source tags by default.");
      parts.push(
        "Only cite memory hits inline as [M1], [M2], etc. when the user explicitly asks for memory citations, sources, or proof."
      );
    }
  }

  if (imageLookup?.requested) {
    if (imageLookup.error) {
      parts.push(`History image lookup failed: ${imageLookup.error}`);
      parts.push("Answer from currently available context and avoid pretending you saw an older image.");
    } else if (!imageLookup.results?.length) {
      parts.push(`History image lookup for "${imageLookup.query || message?.content || ""}" found no matches.`);
      parts.push("Say briefly that no matching prior image was found if the user asked about one.");
    } else {
      parts.push(`History image lookup results for "${imageLookup.query || message?.content || ""}":`);
      parts.push(formatImageLookupResults(imageLookup.results));
      parts.push("Use this visual context directly and avoid guessing details not present.");
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
  parts.push("Treat close misspellings/ASR variants of your name as possibly addressed to you only when context supports it.");
  parts.push("Short callouts like \"yo <name-ish-token>\" or \"hi <name-ish-token>\" are often directed at you.");
  parts.push("Questions like \"is that you <name-ish-token>?\" are often directed at you.");
  parts.push("Do not infer direct address from rhyme alone.");
  parts.push("Generic prank/stank/stinky chatter without a clear name-like callout is usually not directed at you.");
  if (responseRequired) {
    parts.push("A reply is required for this turn unless safety policy requires refusing.");
    parts.push("Do not output [SKIP] except for safety refusals.");
  } else {
    const eagerness = Math.max(0, Math.min(100, Number(replyEagerness) || 0));
    parts.push(`Reply eagerness hint: ${eagerness}/100.`);
    parts.push("Treat reply eagerness as a soft threshold for when your jump-in contribution is worth it.");
    parts.push("Higher eagerness means lower contribution threshold; lower eagerness means higher threshold.");
    if (normalizedChannelMode === "initiative") {
      if (eagerness <= 25) {
        parts.push("In initiative channels, stay selective and skip when a jump-in would feel random or stale.");
      } else if (eagerness >= 75) {
        parts.push("In initiative channels, you can join more often with short social glue when it fits.");
      } else {
        parts.push("In initiative channels, use balanced judgment and keep momentum without forcing it.");
      }
      parts.push("Short acknowledgements, playful riffs, or mood-setting lines are fine when they fit naturally.");
      parts.push("If this would derail, interrupt, or repeat what was just said, output exactly [SKIP].");
      parts.push("Decide if replying improves the channel flow right now.");
    } else {
      if (eagerness <= 25) {
        parts.push("Be very selective and skip unless you can add clearly strong value.");
      } else if (eagerness >= 75) {
        parts.push("You can jump in more often, including lighter/fun contributions that still fit the flow.");
      } else {
        parts.push("Use balanced judgment before joining the conversation.");
      }
      parts.push("Judge value by whether your message is useful, interesting, or funny enough to justify the interruption risk.");
      parts.push("If unsure whether your contribution is worth it, output exactly [SKIP].");
      parts.push("Decide if replying adds value right now.");
      parts.push(
        "If this message is not really meant for you or would interrupt people talking among themselves, output exactly [SKIP]."
      );
    }
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
  if (voiceEnabled) {
    parts.push("Voice mode is enabled right now.");
    parts.push("Do not claim you are text-only or unable to join voice channels.");
    parts.push("If users mention VC/voice requests, stay consistent with voice being available.");
    parts.push(
      "Use conversational continuity: follow-up VC control requests can still be aimed at you even if the user does not repeat your name."
    );
    parts.push(
      "Use recent turn history to resolve target: if someone just addressed you and follows with a short imperative like 'get in vc now', treat it as likely directed at you unless another explicit target is present."
    );
    parts.push(
      "Prioritize who the current message is addressed to over older context when deciding voiceIntent."
    );
    parts.push(
      "If the incoming message is clearly asking you to join, leave, or report VC status, set voiceIntent.intent to join, leave, or status."
    );
    parts.push(
      "If the user clearly asks you to watch their stream in VC, set voiceIntent.intent to watch_stream."
    );
    parts.push(
      "If the user clearly asks you to stop watching stream, set voiceIntent.intent to stop_watching_stream."
    );
    parts.push(
      "If the user asks whether stream watch is on/off, set voiceIntent.intent to stream_status."
    );
    parts.push(
      "Set voiceIntent.confidence from 0 to 1. Use high confidence only for explicit voice-control requests aimed at you."
    );
    parts.push(
      "If the message is clearly aimed at someone else (for example, only tagging another user with no clear reference to you), set voiceIntent.intent to none."
    );
    parts.push(
      "Example: if a message tags another user and says 'come back' without clearly addressing you, set voiceIntent.intent=none."
    );
    parts.push("If intent target is ambiguous, prefer voiceIntent.intent=none with lower confidence.");
    parts.push("For normal chat or ambiguous requests, set voiceIntent.intent to none and keep confidence low.");
  } else {
    parts.push("Voice mode is disabled right now.");
    parts.push("If asked to join VC, say voice mode is currently disabled.");
    parts.push("Set voiceIntent.intent to none.");
  }

  const screenShareEnabled = Boolean(screenShare?.enabled);
  if (screenShareEnabled) {
    const status = String(screenShare?.status || "ready").trim().toLowerCase();
    if (status === "ready") {
      parts.push("You can offer a secure temporary screen-share link when useful.");
      parts.push(
        "If the user asks you to see/watch their screen or stream, set screenShareIntent.action to offer_link."
      );
      parts.push(
        "If visual context would materially improve troubleshooting/help, you may proactively set screenShareIntent.action to offer_link."
      );
      parts.push(
        "Set screenShareIntent.confidence from 0 to 1. Use high confidence only when a share link is clearly useful."
      );
    } else {
      parts.push("Screen-share links are currently unavailable because public HTTPS is not ready.");
      parts.push("Set screenShareIntent.action to none.");
    }
  } else {
    parts.push("Screen-share links are disabled.");
    parts.push("Set screenShareIntent.action to none.");
  }

  if (allowAutomationDirective) {
    const tzLabel = String(automationTimeZoneLabel || "").trim() || "local server time";
    parts.push(`Automations are available for this guild. Scheduler timezone: ${tzLabel}.`);
    parts.push("If the user asks to schedule/start recurring tasks, set automationAction.operation=create.");
    parts.push("For create, set automationAction.schedule with one of:");
    parts.push("- daily: {\"kind\":\"daily\",\"hour\":0-23,\"minute\":0-59}");
    parts.push("- interval: {\"kind\":\"interval\",\"everyMinutes\":integer}");
    parts.push("- once: {\"kind\":\"once\",\"atIso\":\"ISO-8601 timestamp\"}");
    parts.push("For create, set automationAction.instruction to the exact task instruction (what to do each run).");
    parts.push("Use automationAction.runImmediately=true only when user asks for immediate first run.");
    parts.push("If user asks to stop/pause a recurring task, set automationAction.operation=pause with targetQuery.");
    parts.push("If user asks to resume/re-enable, set automationAction.operation=resume with targetQuery.");
    parts.push("If user asks to remove/delete permanently, set automationAction.operation=delete with targetQuery.");
    parts.push("If user asks to see what is scheduled, set automationAction.operation=list.");
    parts.push("When no automation control is requested, set automationAction.operation=none.");
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

  if (allowImageLookupDirective) {
    if (!imageLookup?.enabled) {
      parts.push("History image lookup is unavailable for this turn.");
      parts.push("Set imageLookupQuery to null.");
    } else if (!imageLookup?.candidates?.length) {
      parts.push("No recent image references were found in message history.");
      parts.push("Set imageLookupQuery to null.");
    } else {
      parts.push("History image lookup is available for this turn.");
      parts.push("Recent image references from message history:");
      parts.push(formatImageLookupCandidates(imageLookup.candidates));
      parts.push(
        "If the user refers to an earlier image/photo and current image attachments are insufficient, set imageLookupQuery to a concise lookup query."
      );
      parts.push("Use imageLookupQuery only when needed and keep it under 220 characters.");
      parts.push("If no historical image lookup is needed, set imageLookupQuery to null.");
      parts.push("Do not claim you cannot review earlier shared images when history lookup is available.");
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
    parts.push(`Keep image/video media prompts under ${maxMediaPromptChars} chars, and always include normal reply text.`);
    parts.push(mediaGuidance);
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
    parts.push(
      "If your own reply introduces a durable self fact (stable identity, recurring preference, or explicit standing commitment), set selfMemoryLine."
    );
    parts.push("Use selfMemoryLine only for durable facts about you, not temporary mood or throwaway phrasing.");
    parts.push("Keep selfMemoryLine concise (under 180 chars), concrete, and grounded in your reply text.");
  }

  parts.push("Task: write one natural Discord reply to the incoming message.");
  parts.push("Return strict JSON only. Do not output markdown or code fences.");
  parts.push("JSON format:");
  parts.push(
    "{\"text\":\"reply or [SKIP]\",\"skip\":false,\"reactionEmoji\":null,\"media\":null,\"webSearchQuery\":null,\"memoryLookupQuery\":null,\"imageLookupQuery\":null,\"memoryLine\":null,\"selfMemoryLine\":null,\"automationAction\":{\"operation\":\"none\",\"title\":null,\"instruction\":null,\"schedule\":null,\"targetQuery\":null,\"automationId\":null,\"runImmediately\":false,\"targetChannelId\":null},\"voiceIntent\":{\"intent\":\"none\",\"confidence\":0,\"reason\":null},\"screenShareIntent\":{\"action\":\"none\",\"confidence\":0,\"reason\":null}}"
  );
  parts.push("Set skip=true only when no response should be sent. If skip=true, set text to [SKIP].");
  parts.push("When no reaction is needed, set reactionEmoji to null.");
  parts.push("When no media should be generated, set media to null.");
  parts.push("When no lookup is needed, set webSearchQuery, memoryLookupQuery, and imageLookupQuery to null.");
  parts.push("When no durable fact should be saved, set memoryLine to null.");
  parts.push("When no durable self fact should be saved, set selfMemoryLine to null.");
  parts.push("When no automation command is intended, set automationAction.operation=none and other automationAction fields to null/false.");
  parts.push("Set voiceIntent.intent to one of join|leave|status|watch_stream|stop_watching_stream|stream_status|none.");
  parts.push("When not issuing voice control, set voiceIntent.intent=none, voiceIntent.confidence=0, voiceIntent.reason=null.");
  parts.push("Set screenShareIntent.action to one of offer_link|none.");
  parts.push("When not offering a share link, set screenShareIntent.action=none, screenShareIntent.confidence=0, screenShareIntent.reason=null.");

  return parts.join("\n\n");
}

export function buildAutomationPrompt({
  instruction,
  channelName = "channel",
  recentMessages = [],
  relevantMessages = [],
  userFacts = [],
  relevantFacts = [],
  memoryLookup = null,
  allowMemoryLookupDirective = false,
  allowSimpleImagePosts = false,
  allowComplexImagePosts = false,
  allowVideoPosts = false,
  allowGifs = false,
  remainingImages = 0,
  remainingVideos = 0,
  remainingGifs = 0,
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);
  const taskInstruction = String(instruction || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);

  parts.push("You are executing a scheduled automation task.");
  parts.push(`Target channel: #${String(channelName || "channel").trim() || "channel"}.`);
  parts.push(`Task instruction: ${taskInstruction || "(missing instruction)"}`);
  parts.push("Keep the output in normal persona voice. No robotic framing.");
  parts.push("Recent channel context:");
  parts.push(formatRecentChat(recentMessages));
  if (relevantMessages?.length) {
    parts.push("Relevant past messages:");
    parts.push(formatRecentChat(relevantMessages));
  }
  if (userFacts?.length) {
    parts.push("Known facts about the automation owner:");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: true, maxItems: 8 }));
  }
  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: true, maxItems: 10 }));
  }
  if (memoryLookup?.requested) {
    if (memoryLookup.error) {
      parts.push(`Memory lookup failed: ${memoryLookup.error}`);
      parts.push("Continue using currently available context.");
    } else if (!memoryLookup.results?.length) {
      parts.push(`Memory lookup for "${memoryLookup.query || taskInstruction}" found no durable matches.`);
    } else {
      parts.push(`Memory lookup results for "${memoryLookup.query || taskInstruction}":`);
      parts.push(formatMemoryLookupResults(memoryLookup.results));
      parts.push("If useful, reference these facts naturally in output/media.");
    }
  }
  parts.push("When the task references a person (like 'me'), use durable memory facts if they are relevant.");

  const imageSlots = Math.max(0, Math.floor(Number(remainingImages) || 0));
  const videoSlots = Math.max(0, Math.floor(Number(remainingVideos) || 0));
  const gifSlots = Math.max(0, Math.floor(Number(remainingGifs) || 0));

  if ((allowSimpleImagePosts || allowComplexImagePosts || allowVideoPosts) && (imageSlots > 0 || videoSlots > 0)) {
    parts.push("Media generation is available for this automation run.");
    if (allowSimpleImagePosts && imageSlots > 0) {
      parts.push("For simple image output, set media to {\"type\":\"image_simple\",\"prompt\":\"...\"}.");
    }
    if (allowComplexImagePosts && imageSlots > 0) {
      parts.push("For detailed image output, set media to {\"type\":\"image_complex\",\"prompt\":\"...\"}.");
    }
    if (allowVideoPosts && videoSlots > 0) {
      parts.push("For short generated video, set media to {\"type\":\"video\",\"prompt\":\"...\"}.");
    }
    parts.push(`Keep image/video prompts under ${maxMediaPromptChars} chars.`);
    parts.push(mediaGuidance);
  } else {
    parts.push("Generated image/video is unavailable this run. Set media to null.");
  }

  if (allowGifs && gifSlots > 0) {
    parts.push("GIF lookup is available this run. Use media {\"type\":\"gif\",\"prompt\":\"short query\"} when it helps.");
  }

  parts.push("Return strict JSON only.");
  parts.push("JSON format:");
  parts.push(
    "{\"text\":\"message or [SKIP]\",\"skip\":false,\"reactionEmoji\":null,\"media\":null,\"webSearchQuery\":null,\"memoryLookupQuery\":null,\"memoryLine\":null,\"selfMemoryLine\":null,\"automationAction\":{\"operation\":\"none\",\"title\":null,\"instruction\":null,\"schedule\":null,\"targetQuery\":null,\"automationId\":null,\"runImmediately\":false,\"targetChannelId\":null},\"voiceIntent\":{\"intent\":\"none\",\"confidence\":0,\"reason\":null}}"
  );
  parts.push("Set webSearchQuery, memoryLine, and selfMemoryLine to null.");
  if (allowMemoryLookupDirective) {
    if (!memoryLookup?.enabled) {
      parts.push("Durable memory lookup is unavailable for this run. Set memoryLookupQuery to null.");
    } else {
      parts.push("Durable memory lookup is available.");
      parts.push("If memory context is insufficient for the task, set memoryLookupQuery to a concise query.");
      parts.push("If not needed, set memoryLookupQuery to null.");
    }
  } else {
    parts.push("Set memoryLookupQuery to null.");
  }
  parts.push("Set automationAction.operation=none and voiceIntent.intent=none.");
  parts.push("Use [SKIP] only when sending nothing is clearly best.");

  return parts.join("\n\n");
}

export function buildVoiceTurnPrompt({
  speakerName = "unknown",
  transcript = "",
  userFacts = [],
  relevantFacts = [],
  isEagerTurn = false,
  voiceEagerness = 0,
  conversationContext = null,
  joinWindowActive = false,
  joinWindowAgeMs = null,
  botName = "the bot",
  soundboardCandidates = [],
  memoryEnabled = false,
  webSearch = null,
  allowWebSearchDirective = false,
  screenShare = null,
  allowScreenShareDirective = false
}) {
  const parts = [];
  const voiceToneGuardrails = buildVoiceToneGuardrails();
  const speaker = String(speakerName || "unknown").trim() || "unknown";
  const text = String(transcript || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  const normalizedSoundboardCandidates = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 40);
  const normalizedBotName = String(botName || "the bot").trim() || "the bot";
  const normalizedConversationContext =
    conversationContext && typeof conversationContext === "object" ? conversationContext : null;

  parts.push(`Incoming live voice transcript from ${speaker}: ${text || "(empty)"}`);
  parts.push(
    `Interpret second-person references like \"you\"/\"your\" as likely referring to ${normalizedBotName} unless another human target is explicit.`
  );

  if (normalizedConversationContext) {
    parts.push(
      [
        "Conversation attention context:",
        `- State: ${String(normalizedConversationContext.engagementState || "wake_word_biased")}`,
        `- Engaged with current speaker: ${normalizedConversationContext.engagedWithCurrentSpeaker ? "yes" : "no"}`,
        `- Current speaker matches focused speaker: ${normalizedConversationContext.sameAsFocusedSpeaker ? "yes" : "no"}`,
        `- Recent bot reply ms ago: ${
          Number.isFinite(normalizedConversationContext.msSinceAssistantReply)
            ? Math.round(normalizedConversationContext.msSinceAssistantReply)
            : "none"
        }`,
        `- Recent direct address ms ago: ${
          Number.isFinite(normalizedConversationContext.msSinceDirectAddress)
            ? Math.round(normalizedConversationContext.msSinceDirectAddress)
            : "none"
        }`
      ].join("\n")
    );
  }

  if (joinWindowActive) {
    parts.push(
      `Join window active: yes${
        Number.isFinite(joinWindowAgeMs) ? ` (${Math.max(0, Math.round(Number(joinWindowAgeMs)))}ms since join)` : ""
      }.`
    );
    parts.push(
      "Join-window bias: if this turn is a short greeting/check-in (for example hi/hey/yo/what's up), reply with a brief acknowledgement instead of [SKIP] unless clearly aimed at another human."
    );
  }

  if (userFacts?.length) {
    parts.push("Known facts about this user:");
    parts.push(formatMemoryFacts(userFacts, { includeType: false, includeProvenance: false, maxItems: 8 }));
  }

  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: false, maxItems: 8 }));
  }

  if (memoryEnabled) {
    parts.push("Optional memory directives:");
    parts.push("- [[MEMORY_LINE:<durable fact from the speaker turn>]]");
    parts.push("- [[SELF_MEMORY_LINE:<durable fact about your own stable identity/preference/commitment in your reply>]]");
    parts.push("Use these only when genuinely durable and grounded. Omit when not needed.");
  }

  if (normalizedSoundboardCandidates.length) {
    parts.push("Optional soundboard refs:");
    parts.push(normalizedSoundboardCandidates.join("\n"));
    parts.push(
      "If you want a soundboard effect, append exactly one trailing directive: [[SOUNDBOARD:<sound_ref>]] where <sound_ref> matches the list exactly."
    );
    parts.push("If no soundboard effect should play, omit the directive.");
  }

  if (allowWebSearchDirective) {
    if (webSearch?.optedOutByUser) {
      parts.push("The user asked not to use web search.");
      parts.push("Do not output [[WEB_SEARCH:...]].");
    } else if (!webSearch?.enabled) {
      parts.push("Live web lookup is disabled in settings.");
      parts.push("Do not output [[WEB_SEARCH:...]].");
    } else if (!webSearch?.configured) {
      parts.push("Live web lookup is unavailable (provider not configured).");
      parts.push("Do not output [[WEB_SEARCH:...]].");
    } else if (webSearch?.blockedByBudget || !webSearch?.budget?.canSearch) {
      parts.push("Live web lookup is unavailable right now (budget exhausted).");
      parts.push("Do not output [[WEB_SEARCH:...]].");
    } else {
      parts.push("Live web lookup is available.");
      parts.push(
        "If your spoken response needs fresh web info for accuracy, output a trailing directive [[WEB_SEARCH:<concise query>]]."
      );
      parts.push("Only use one web-search directive when needed.");
    }
  } else {
    parts.push("Do not output [[WEB_SEARCH:...]].");
  }

  if (allowScreenShareDirective) {
    parts.push("VC screen-share link offers are available.");
    parts.push(
      "If the speaker asks you to see/watch their screen or stream, append a trailing directive [[SCREEN_SHARE_LINK]]."
    );
    parts.push("Only use one screen-share directive when it is clearly useful.");
  } else if (screenShare?.enabled && String(screenShare?.status || "").trim().toLowerCase() !== "ready") {
    parts.push("Screen-share links are currently unavailable.");
    parts.push("Do not output [[SCREEN_SHARE_LINK]].");
  } else {
    parts.push("Do not output [[SCREEN_SHARE_LINK]].");
  }

  if (webSearch?.requested && !webSearch?.used) {
    if (webSearch.error) {
      parts.push(`Web lookup failed: ${webSearch.error}`);
      parts.push("Answer without claiming live lookup succeeded.");
    } else if (!webSearch.results?.length) {
      parts.push("A web lookup was attempted, but no useful results were found.");
      parts.push("Answer carefully and avoid invented specifics.");
    }
  }

  if (webSearch?.used && webSearch.results?.length) {
    parts.push(`Live web findings for query: "${webSearch.query}"`);
    parts.push(formatWebSearchFindings(webSearch));
  }

  if (isEagerTurn) {
    const eagerness = Math.max(0, Math.min(100, Number(voiceEagerness) || 0));
    parts.push(`You were NOT directly addressed. You're considering whether to chime in.`);
    parts.push(`Voice reply eagerness: ${eagerness}/100.`);
    if (normalizedConversationContext?.engagedWithCurrentSpeaker) {
      parts.push("You are actively in this speaker's thread. Lean toward a short helpful reply over [SKIP].");
    }
    parts.push("Only speak up if you can genuinely add value. If not, output exactly [SKIP].");

    parts.push(...voiceToneGuardrails);
    parts.push(
      "Task: respond as a natural spoken VC reply, or output exactly [SKIP] if you have nothing to add."
    );
    parts.push(
      "If responding, use plain text only. No tags or markdown; only optional trailing directives listed above are allowed."
    );
  } else {
    parts.push(...voiceToneGuardrails);
    parts.push("Task: respond as a natural spoken VC reply.");
    parts.push(
      "Use plain text only. Do not output tags, markdown, or [SKIP]. Only optional trailing directives listed above are allowed."
    );
  }

  return parts.join("\n\n");
}

export function buildInitiativePrompt({
  channelName,
  recentMessages,
  relevantFacts = [],
  emojiHints,
  allowSimpleImagePosts,
  allowComplexImagePosts,
  allowVideoPosts,
  remainingInitiativeImages = 0,
  remainingInitiativeVideos = 0,
  discoveryFindings = [],
  maxLinksPerPost = 2,
  requireDiscoveryLink = false,
  maxMediaPromptChars = 900,
  mediaPromptCraftGuidance = null
}) {
  const parts = [];
  const mediaGuidance = String(mediaPromptCraftGuidance || "").trim() || getMediaPromptCraftGuidance(null);

  parts.push(
    `You are posting proactively in #${channelName}. No one directly asked you to respond.`
  );
  parts.push("Recent channel messages:");
  parts.push(formatRecentChat(recentMessages));
  if (relevantFacts?.length) {
    parts.push("Relevant durable memory:");
    parts.push(formatMemoryFacts(relevantFacts, { includeType: true, includeProvenance: false, maxItems: 8 }));
  }

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
      `Keep IMAGE_PROMPT, COMPLEX_IMAGE_PROMPT, and VIDEO_PROMPT under ${maxMediaPromptChars} chars.`
    );
    parts.push(
      "Any visual prompt must avoid visible text, letters, numbers, logos, subtitles, captions, UI, or watermarks."
    );
    parts.push(mediaGuidance);
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
