import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  fetchGuildSoundboardCandidates,
  maybeTriggerAssistantDirectedSoundboard,
  normalizeSoundboardRefs,
  resolveSoundboardCandidates
} from "./voiceSoundboard.ts";

function createSoundboardHost({
  guild = null,
  play = async () => ({ ok: true })
}: {
  guild?: Record<string, unknown> | null;
  play?: (args: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string | null; message?: string | null }>;
} = {}) {
  const actions: Array<Record<string, unknown>> = [];
  const playCalls: Array<Record<string, unknown>> = [];

  return {
    host: {
      client: {
        user: {
          id: "bot-1"
        },
        guilds: {
          cache: {
            get() {
              return guild;
            }
          }
        }
      },
      store: {
        logAction(entry: Record<string, unknown>) {
          actions.push(entry);
        }
      },
      soundboardDirector: {
        async play(args: Record<string, unknown>) {
          playCalls.push(args);
          return await play(args);
        }
      }
    },
    actions,
    playCalls
  };
}

function createGuildSoundboard(sounds: Array<Record<string, unknown>>) {
  let fetchCalls = 0;

  return {
    guild: {
      soundboardSounds: {
        async fetch() {
          fetchCalls += 1;
          return {
            forEach(callback: (sound: Record<string, unknown>) => void) {
              sounds.forEach((sound) => callback(sound));
            }
          };
        }
      }
    },
    get fetchCalls() {
      return fetchCalls;
    }
  };
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    mode: "voice_agent",
    ending: false,
    settingsSnapshot: null,
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0,
      catalogCandidates: [],
      catalogFetchedAt: 0,
      lastDirectiveKey: "",
      lastDirectiveAt: 0
    },
    ...overrides
  };
}

test("normalizeSoundboardRefs trims values, removes blanks, and caps size and length", () => {
  const refs = normalizeSoundboardRefs([
    null,
    "  airhorn  ",
    42,
    "",
    "x".repeat(400),
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen"
  ]);

  assert.deepEqual(refs, [
    "airhorn",
    "42",
    "x".repeat(180),
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine"
  ]);
});

test("fetchGuildSoundboardCandidates fetches, dedupes, caches, and reuses guild catalog entries", async () => {
  const guildSoundboard = createGuildSoundboard([
    { soundId: "airhorn", name: "Air Horn", available: true },
    { soundId: "AIRHORN", name: "Duplicate", available: true },
    { soundId: "rimshot", name: "Rim Shot", available: true },
    { soundId: "", name: "Missing Id", available: true },
    { soundId: "boo", name: "Unavailable", available: false }
  ]);
  const { host } = createSoundboardHost({
    guild: guildSoundboard.guild
  });
  const session = createSession();

  const first = await fetchGuildSoundboardCandidates(host, { session });
  const second = await fetchGuildSoundboardCandidates(host, { session });

  assert.deepEqual(first, [
    {
      soundId: "airhorn",
      sourceGuildId: null,
      reference: "airhorn",
      name: "Air Horn",
      origin: "guild_catalog"
    },
    {
      soundId: "rimshot",
      sourceGuildId: null,
      reference: "rimshot",
      name: "Rim Shot",
      origin: "guild_catalog"
    }
  ]);
  assert.deepEqual(second, first);
  assert.equal(guildSoundboard.fetchCalls, 1);
  assert.deepEqual(session.soundboard.catalogCandidates, first);
  assert.ok(Number(session.soundboard.catalogFetchedAt) > 0);
});

test("resolveSoundboardCandidates prefers configured soundboard references over guild catalog fetches", async () => {
  const guildSoundboard = createGuildSoundboard([
    { soundId: "guild-only", name: "Guild Only", available: true }
  ]);
  const { host } = createSoundboardHost({
    guild: guildSoundboard.guild
  });
  const settings = createTestSettings({
    voice: {
      soundboard: {
        enabled: true,
        preferredSoundIds: ["airhorn@123", "rimshot"]
      }
    }
  });

  const result = await resolveSoundboardCandidates(host, {
    session: createSession(),
    settings
  });

  assert.equal(result.source, "preferred");
  assert.deepEqual(result.candidates, [
    {
      soundId: "airhorn",
      sourceGuildId: "123",
      reference: "airhorn@123",
      name: null,
      origin: "preferred"
    },
    {
      soundId: "rimshot",
      sourceGuildId: null,
      reference: "rimshot",
      name: null,
      origin: "preferred"
    }
  ]);
  assert.equal(guildSoundboard.fetchCalls, 0);
});

test("maybeTriggerAssistantDirectedSoundboard resolves candidates, plays once, and suppresses duplicate directives", async () => {
  const session = createSession();
  const settings = createTestSettings({
    voice: {
      soundboard: {
        enabled: true,
        preferredSoundIds: ["airhorn@123"]
      }
    }
  });
  const { host, actions, playCalls } = createSoundboardHost();

  await maybeTriggerAssistantDirectedSoundboard(host, {
    session,
    settings,
    userId: "user-1",
    transcript: "play the airhorn now",
    requestedRef: "airhorn@123",
    source: "voice_transcript"
  });
  await maybeTriggerAssistantDirectedSoundboard(host, {
    session,
    settings,
    userId: "user-1",
    transcript: "play the airhorn now",
    requestedRef: "airhorn@123",
    source: "voice_transcript"
  });

  assert.equal(playCalls.length, 1);
  assert.deepEqual(playCalls[0], {
    session,
    settings,
    soundId: "airhorn",
    sourceGuildId: "123",
    reason: "assistant_directive_voice_transcript"
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.content, "voice_soundboard_directive_decision");
  assert.equal(actions[1]?.content, "voice_soundboard_directive_played");
  assert.equal(actions[0]?.metadata?.matchedReference, "airhorn@123");
});
