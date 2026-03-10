import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./index.ts";

test("buildVoiceTurnPrompt treats event cues as room context", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    inputKind: "event",
    transcript: "[alice joined the voice channel]"
  });

  assert.equal(
    prompt.includes(
      "This is a voice-room event cue, not literal quoted speech."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "If a brief acknowledgement of the join/leave would feel natural, you may reply briefly. Otherwise use [SKIP]."
    ),
    true
  );
});

test("buildVoiceTurnPrompt biases low-information eager turns toward skip", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "haha",
    isEagerTurn: true,
    voiceEagerness: 50
  });

  assert.equal(
    prompt.includes(
      "If the turn is laughter, filler, backchannel noise (haha, lol, hmm, mm, uh-huh, yup), or self-talk/thinking out loud"
    ),
    true
  );
});

test("buildVoiceTurnPrompt treats fuzzy bot-name cues as a positive signal", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hey clanker play some music",
    botName: "clanker conk",
    directAddressed: false
  });

  assert.equal(
    prompt.includes(
      "The transcript may be using clanker conk's name or a phonetic variation of it. Treat that as a positive signal that the speaker may be talking to you."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "The transcript contains your name or a phonetic variant of it. This is a strong signal the speaker is talking to you"
    ),
    true
  );
});

test("buildVoiceTurnPrompt explains browser tool usage when interactive browsing is available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you check that website for me",
    allowBrowserBrowseToolCall: true,
    browserBrowse: {
      enabled: true,
      configured: true,
      blockedByBudget: false,
      budget: {
        canBrowse: true
      }
    }
  });

  assert.equal(prompt.includes("browser_browse:"), true);
  assert.equal(prompt.includes("interactive browsing"), true);
  assert.equal(prompt.includes("screenshots"), true);
});

test("buildVoiceTurnPrompt explains screen-share tool usage when link offers are available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you watch my screen",
    allowScreenShareToolCall: true,
    screenShare: {
      enabled: true,
      available: true,
      status: "ready",
      reason: null
    }
  });

  assert.equal(prompt.includes("offer_screen_share_link"), true);
  assert.equal(prompt.includes("watch their screen"), true);
  assert.equal(prompt.includes("voice JSON contract"), false);
});

test("buildVoiceTurnPrompt prefers tool calls over stale helper fields", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "can you open that article and search the web",
    allowMemoryToolCalls: true,
    allowWebSearchToolCall: true,
    allowOpenArticleToolCall: true,
    allowVoiceToolCalls: true,
    openArticleCandidates: [
      {
        ref: "r1:1",
        title: "Example",
        url: "https://example.com/article",
        domain: "example.com",
        query: "example"
      }
    ],
    webSearch: {
      enabled: true,
      configured: true,
      blockedByBudget: false,
      budget: {
        canSearch: true
      }
    },
    musicContext: {
      playbackState: "playing",
      currentTrack: {
        id: "track-current",
        title: "Example Song",
        artists: ["Example Artist"]
      },
      lastTrack: null,
      queueLength: 2,
      upcomingTracks: [
        { id: "track-next", title: "Next Song", artist: "Next Artist" }
      ],
      lastAction: "play_now",
      lastQuery: "example song"
    }
  });

  assert.equal(prompt.includes("Tools:"), true);
  assert.equal(prompt.includes("Speak first on casual turns"), true);
  assert.equal(prompt.includes("never claim success before a tool returns"), true);
  assert.equal(prompt.includes("web_search"), true);
  assert.equal(prompt.includes("open_article"), true);
  assert.equal(prompt.includes("memory_write"), true);
  assert.equal(prompt.includes("memory_search"), false);
  assert.equal(prompt.includes("note_context"), true);
  assert.equal(prompt.includes("music_play"), true);
  assert.equal(prompt.includes("set_addressing"), false);
  assert.equal(prompt.includes("Music:"), true);
  assert.equal(prompt.includes("Now: Example Song by Example Artist"), true);
  assert.equal(prompt.includes("selection_id: track-current"), true);
  assert.equal(prompt.includes("Next Song - Next Artist"), true);
  assert.equal(prompt.includes("selection_id: track-next"), true);
  assert.equal(prompt.includes("queue_add+skip"), true);
  assert.equal(prompt.includes("set webSearchQuery"), false);
  assert.equal(prompt.includes("set openArticleRef"), false);
  assert.equal(prompt.includes("Set memoryLine"), false);
});

test("buildVoiceTurnPrompt renders durable session context above conversation history", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "what were we saying earlier?",
    allowVoiceToolCalls: true,
    durableContext: [
      {
        text: "Alice prefers concise answers in this session",
        category: "preference",
        at: Date.now()
      }
    ],
    recentConversationHistory: [
      {
        ageMinutes: 3,
        messages: [
          {
            author_name: "alice",
            content: "keep it short",
            is_bot: 0
          }
        ]
      }
    ]
  });

  assert.equal(prompt.includes("Session context:"), true);
  assert.equal(prompt.includes("- [preference] Alice prefers concise answers in this session"), true);
  assert.equal(prompt.indexOf("Session context:") < prompt.indexOf("Past conversation:"), true);
  assert.equal(prompt.includes("note_context"), true);
});

test("buildVoiceTurnPrompt trims session context to the most recent prompt-safe entries", () => {
  const durableContext = Array.from({ length: 16 }, (_, index) => ({
    text: `Context item ${String(index + 1).padStart(2, "0")}`,
    category: index % 2 === 0 ? "fact" : "plan",
    at: index + 1
  }));

  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "keep going",
    allowVoiceToolCalls: true,
    durableContext
  });

  assert.equal(prompt.includes("Session context:"), true);
  assert.equal(prompt.includes("Context item 01"), false);
  assert.equal(prompt.includes("Context item 04"), false);
  assert.equal(prompt.includes("Context item 05"), true);
  assert.equal(prompt.includes("Context item 16"), true);
});

test("buildVoiceTurnPrompt includes interruption recovery context for the next turn", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "actually make it rock instead",
    conversationContext: {
      engagementState: "engaged",
      engaged: true,
      engagedWithCurrentSpeaker: true,
      recentAssistantReply: true,
      recentDirectAddress: true,
      sameAsRecentDirectAddress: true,
      msSinceAssistantReply: 800,
      msSinceDirectAddress: 800,
      interruptedAssistantReply: {
        utteranceText: "let me explain the jazz playlist options",
        interruptedByUserId: "user-1",
        interruptedBySpeakerName: "alice",
        interruptedAt: Date.now() - 1200,
        ageMs: 1200,
        source: "barge_in_interrupt"
      }
    }
  });

  assert.equal(prompt.includes("Interruption recovery context:"), true);
  assert.equal(prompt.includes("alice interrupted you"), true);
  assert.equal(prompt.includes("let me explain the jazz playlist options"), true);
  assert.equal(prompt.includes('They then said: "actually make it rock instead"'), true);
  assert.equal(prompt.includes("Do not mechanically continue the old answer if the new turn changes direction."), true);
});

test("buildVoiceTurnPrompt teaches inline soundboard directives when ordered soundboard sequencing is available", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "that was brutal",
    allowSoundboardToolCall: true,
    allowInlineSoundboardDirectives: true,
    soundboardCandidates: ["rimshot@123"],
    soundboardEagerness: 82
  });

  assert.equal(prompt.includes("Discord soundboard tendency: 82/100"), true);
  assert.equal(prompt.includes("playful soundboard bits and comedic punctuation"), true);
  assert.equal(prompt.includes("[[SOUNDBOARD:<ref>]]"), true);
  assert.equal(prompt.includes("inline and tool-call the same sound"), true);
});

test("buildVoiceTurnPrompt keeps play_soundboard as the fallback when inline directives are unavailable", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hit the rimshot",
    allowSoundboardToolCall: true,
    allowInlineSoundboardDirectives: false,
    soundboardCandidates: ["rimshot@123"],
    soundboardEagerness: 82
  });

  assert.equal(prompt.includes("Inline directives unavailable"), true);
  assert.equal(prompt.includes("play_soundboard"), true);
  assert.equal(prompt.includes("Don't output [[SOUNDBOARD:...]] markup"), true);
});
