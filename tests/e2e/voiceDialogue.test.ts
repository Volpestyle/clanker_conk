import { test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  beginTemporaryE2EWithPreset,
  DriverBot,
  getE2EConfig,
  hasDialogueE2EConfig,
  getFixturePath,
  generatePcmAudioFixture,
  restoreTemporaryE2ESettings
} from "./driver/index.ts";
import { RECENT_ENGAGEMENT_WINDOW_MS } from "../../src/voice/voiceSessionManager.constants.ts";

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const SKIP_MSG = "Skipping dialogue E2E tests: set E2E_DRIVER_BOT_2_TOKEN";
const DEFAULT_TIMEOUT_MS = 90_000;
const SILENCE_WINDOW_MS = 8_000;

/**
 * Two-person dialogue tests.
 *
 * Uses two independent driver bots (simulating real users) to have a
 * conversation that does NOT address the system bot. The system bot
 * should stay silent — it must not interrupt undirected dialogue.
 */
describe("E2E: Voice Dialogue (Two Speakers)", () => {
  let driverA: DriverBot;
  let driverB: DriverBot;

  beforeAll(async () => {
    if (!hasDialogueE2EConfig()) {
      console.log(SKIP_MSG);
      return;
    }

    const config = getE2EConfig();
    const presetName = await beginTemporaryE2EWithPreset();
    console.log(`[E2E] Pipeline preset: ${presetName}`);

    const baseConfig = {
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };

    driverA = new DriverBot({ ...baseConfig, token: config.driverBotToken });
    driverB = new DriverBot({ ...baseConfig, token: config.driverBot2Token });

    // Connect both bots in parallel
    await Promise.all([driverA.connect(), driverB.connect()]);

    // Join voice in parallel
    await Promise.all([
      driverA.joinVoiceChannel(),
      driverB.joinVoiceChannel()
    ]);

    // Summon the system bot via driver A (only need one to do this)
    await driverA.summonSystemBot(45_000);

    // Let things settle after warmup before dialogue tests begin
    await new Promise((r) => setTimeout(r, 3_000));
  }, 120_000);

  afterAll(async () => {
    try { await driverA?.dismissBot("dismiss_dialogue", "Hey clanker, we're done here, catch ya later!"); } catch { /* ignore */ }
    await Promise.all([
      driverA?.destroy(),
      driverB?.destroy()
    ]);
    await restoreTemporaryE2ESettings();
  }, 60_000);

  beforeEach(() => {
    if (!driverA || !driverB) return;
    driverA.clearReceivedAudio();
    driverB.clearReceivedAudio();
  });

  // ----------------------------------------------------------------
  // Fixture generation helper — generates dialogue fixtures if missing
  // ----------------------------------------------------------------
  async function ensureFixture(name: string, text: string): Promise<string> {
    const path = getFixturePath(name);
    try {
      const { stat } = await import("node:fs/promises");
      await stat(path);
      return path;
    } catch {
      console.log(`Generating fixture: ${name} ("${text}")`);
      await generatePcmAudioFixture(name, text);
      return getFixturePath(name);
    }
  }

  test(
    "Dialogue: Two users chat — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const fixtureA = await ensureFixture(
        "dialogue_a1",
        "Hey did you see the game last night? It was insane."
      );
      const fixtureB = await ensureFixture(
        "dialogue_b1",
        "Yeah I know right, I can't believe they pulled it off in overtime."
      );

      // Clear audio before the dialogue begins
      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Speaker A says something to Speaker B
      console.log("[Dialogue] Speaker A talking...");
      await driverA.playAudio(fixtureA);

      // Brief natural pause between speakers
      await new Promise((r) => setTimeout(r, 1_500));

      // Speaker B responds to Speaker A
      console.log("[Dialogue] Speaker B talking...");
      await driverB.playAudio(fixtureB);

      // Wait and observe — the bot should NOT speak
      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent during undirected dialogue, but driverA received ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent during undirected dialogue, but driverB received ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Multi-turn conversation — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const turns = [
        { driver: "A", name: "dialogue_a2", text: "So what are you working on today?" },
        { driver: "B", name: "dialogue_b2", text: "Just fixing some bugs in the backend. The usual." },
        { driver: "A", name: "dialogue_a3", text: "Nice. I'm doing a code review, it's pretty long." },
        { driver: "B", name: "dialogue_b3", text: "Yeah those are the worst. Good luck with that." }
      ];

      // Pre-generate all fixtures in parallel
      const fixtures = await Promise.all(
        turns.map((t) => ensureFixture(t.name, t.text))
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Play the conversation turn by turn
      for (let i = 0; i < turns.length; i++) {
        const speaker = turns[i].driver === "A" ? driverA : driverB;
        console.log(`[Dialogue] Turn ${i + 1}: Speaker ${turns[i].driver} — "${turns[i].text}"`);
        await speaker.playAudio(fixtures[i]);
        // Natural inter-turn gap
        await new Promise((r) => setTimeout(r, 1_200));
      }

      // Wait for potential bot response
      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent during multi-turn dialogue, but driverA received ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent during multi-turn dialogue, but driverB received ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Bot responds when directly addressed mid-conversation",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const chatFixture = await ensureFixture(
        "dialogue_b4",
        "I was thinking we should grab lunch after this."
      );
      const addressFixture = await ensureFixture(
        "dialogue_a_address_bot",
        "Hey clanker, what do you think about that?"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Speaker B says something undirected
      console.log("[Dialogue] Speaker B chatting...");
      await driverB.playAudio(chatFixture);
      await new Promise((r) => setTimeout(r, 1_200));

      // Speaker A directly addresses the bot
      console.log("[Dialogue] Speaker A addressing bot...");
      driverA.clearReceivedAudio();
      await driverA.playAudio(addressFixture);

      // Wait for response
      console.log(`[Dialogue] Waiting ${responseWaitMs}ms for bot response...`);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const bytesA = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Audio from bot: ${bytesA} bytes`);

      assert.ok(
        bytesA > 0,
        `Bot should respond when directly addressed, but got ${bytesA} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Bot returns to silence after responding",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      // First, address the bot to trigger a response
      const addressFixture = await ensureFixture(
        "dialogue_a_ping",
        "Hey clanker, you there?"
      );

      driverA.clearReceivedAudio();
      await driverA.playAudio(addressFixture);

      // Wait for the bot to finish responding
      await new Promise((r) => setTimeout(r, responseWaitMs));
      const responded = driverA.getReceivedAudioBytes() > 0;
      console.log(`[Dialogue] Bot responded to ping: ${responded}`);

      // Now resume undirected dialogue — bot should go quiet again
      const resumeA = await ensureFixture(
        "dialogue_a5",
        "Anyway, where were we? Oh right, the deployment."
      );
      const resumeB = await ensureFixture(
        "dialogue_b5",
        "Yeah let's roll it out after lunch I think."
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Resuming undirected conversation...");
      await driverA.playAudio(resumeA);
      await new Promise((r) => setTimeout(r, 1_200));
      await driverB.playAudio(resumeB);

      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      console.log(`[Dialogue] Audio received — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should return to silence after undirected dialogue resumes, but driverA got ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should return to silence after undirected dialogue resumes, but driverB got ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Speaker redirects to another person after addressing bot",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_redirect_address_bot",
        "Hey clanker, what's your take on this idea?"
      );
      const redirectFixture = await ensureFixture(
        "dialogue_a_redirect_to_b",
        "Actually Sarah, what do you think? I'm asking you, not clanker."
      );
      const replyFixture = await ensureFixture(
        "dialogue_b_redirect_reply",
        "I think it's solid, we just need to tighten the rollout plan."
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speaker A addressing bot...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      assert.ok(
        driverA.getReceivedAudioBytes() > 0,
        "Bot should respond to the initial direct address before the redirect"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speaker A redirecting to speaker B...");
      await driverA.playAudio(redirectFixture);
      await new Promise((r) => setTimeout(r, 1_200));

      console.log("[Dialogue] Speaker B replying to speaker A...");
      await driverB.playAudio(replyFixture);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent after the speaker redirects to another person, but driverA got ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent after the speaker redirects to another person, but driverB got ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Speaker drops bot thread and switches to unrelated side conversation",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_sidequest_address_bot",
        "Clanker, should we ship this today or wait until tomorrow?"
      );
      const pivotFixture = await ensureFixture(
        "dialogue_a_sidequest_pivot",
        "Never mind, did you end up ordering that pizza for the team?"
      );
      const replyFixture = await ensureFixture(
        "dialogue_b_sidequest_reply",
        "Yeah, I ordered it already, it should be here in twenty minutes."
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speaker A addressing bot...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      assert.ok(
        driverA.getReceivedAudioBytes() > 0,
        "Bot should respond to the initial direct address before the speaker pivots away"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speaker A pivoting to unrelated side conversation...");
      await driverA.playAudio(pivotFixture);
      await new Promise((r) => setTimeout(r, 1_200));

      console.log("[Dialogue] Speaker B answering side conversation...");
      await driverB.playAudio(replyFixture);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();

      assert.strictEqual(
        bytesA,
        0,
        `Bot should ignore an unrelated side conversation after a topic switch, but driverA got ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should ignore an unrelated side conversation after a topic switch, but driverB got ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  // ----------------------------------------------------------------
  // Conversational follow-up tests — engagement window behavior
  // ----------------------------------------------------------------

  test(
    "Dialogue: Same speaker follows up without wake word — bot responds within engagement window",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_followup_address",
        "Hey clanker, how's it going?"
      );
      const followupFixture = await ensureFixture(
        "dialogue_a_followup_casual",
        "Yo, what's up man? What have you been up to?"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Step 1: Speaker A addresses the bot by name to establish engagement
      console.log("[Dialogue] Speaker A addressing bot to establish engagement...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const initialBytes = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Bot responded to initial address: ${initialBytes} bytes`);
      assert.ok(
        initialBytes > 0,
        "Bot must respond to the initial direct address to establish engagement"
      );

      // Step 2: Wait for the bot to finish speaking, then follow up WITHOUT
      // using the wake word — still within the engagement window.
      // Use a pause that's clearly within RECENT_ENGAGEMENT_WINDOW_MS.
      const followupDelayMs = Math.min(5_000, Math.floor(RECENT_ENGAGEMENT_WINDOW_MS * 0.4));
      console.log(`[Dialogue] Waiting ${followupDelayMs}ms before casual follow-up (engagement window: ${RECENT_ENGAGEMENT_WINDOW_MS}ms)...`);
      await new Promise((r) => setTimeout(r, followupDelayMs));

      driverA.clearReceivedAudio();

      // Speaker A follows up casually — no bot name, just continuing the conversation
      console.log("[Dialogue] Speaker A following up without wake word...");
      await driverA.playAudio(followupFixture);

      console.log(`[Dialogue] Waiting ${responseWaitMs}ms for bot response to follow-up...`);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const followupBytes = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Bot response to follow-up: ${followupBytes} bytes`);

      assert.ok(
        followupBytes > 0,
        `Bot should respond to a casual follow-up within the engagement window (${RECENT_ENGAGEMENT_WINDOW_MS}ms) without requiring the wake word, but got ${followupBytes} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Speaker A addresses bot, Speaker B follows up — bot responds to B within engagement window",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_multiuser_address",
        "Hey clanker, tell us a fun fact."
      );
      const followupFixture = await ensureFixture(
        "dialogue_b_multiuser_followup",
        "Oh that's cool, do you know any more like that?"
      );

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      // Step 1: Speaker A addresses the bot
      console.log("[Dialogue] Speaker A addressing bot...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const initialBytes = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Bot responded to Speaker A: ${initialBytes} bytes`);
      assert.ok(
        initialBytes > 0,
        "Bot must respond to Speaker A's direct address"
      );

      // Step 2: Speaker B follows up naturally — this is a continuation of the
      // same group conversation, no intervening side chatter.
      const followupDelayMs = Math.min(5_000, Math.floor(RECENT_ENGAGEMENT_WINDOW_MS * 0.4));
      console.log(`[Dialogue] Waiting ${followupDelayMs}ms before Speaker B follow-up...`);
      await new Promise((r) => setTimeout(r, followupDelayMs));

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speaker B following up without wake word...");
      await driverB.playAudio(followupFixture);

      console.log(`[Dialogue] Waiting ${responseWaitMs}ms for bot response to Speaker B...`);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      const followupBytesA = driverA.getReceivedAudioBytes();
      const followupBytesB = driverB.getReceivedAudioBytes();
      const totalFollowupBytes = followupBytesA + followupBytesB;
      console.log(`[Dialogue] Bot response to Speaker B follow-up: driverA=${followupBytesA}, driverB=${followupBytesB}`);

      assert.ok(
        totalFollowupBytes > 0,
        `Bot should respond to Speaker B's follow-up within the engagement window without requiring the wake word, but got ${totalFollowupBytes} bytes total`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Two speakers have side conversation after bot responds — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_side_conv_address",
        "Clanker, what time is it?"
      );
      const sideA = await ensureFixture(
        "dialogue_a_side_conv_pivot",
        "Anyway dude, you wanna grab food after this?"
      );
      const sideB = await ensureFixture(
        "dialogue_b_side_conv_reply",
        "Yeah I'm starving, let's hit that taco place."
      );

      driverA.clearReceivedAudio();

      // Step 1: Address the bot to establish engagement
      console.log("[Dialogue] Speaker A addressing bot...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      assert.ok(
        driverA.getReceivedAudioBytes() > 0,
        "Bot must respond to the direct address"
      );

      // Step 2: Both speakers start a side conversation with each other.
      // The conversation is clearly between them (A asks B, B answers A).
      // Bot should recognize this is not directed at it.
      const sideDelayMs = Math.min(4_000, Math.floor(RECENT_ENGAGEMENT_WINDOW_MS * 0.3));
      await new Promise((r) => setTimeout(r, sideDelayMs));

      driverA.clearReceivedAudio();
      driverB.clearReceivedAudio();

      console.log("[Dialogue] Speakers pivot to side conversation...");
      await driverA.playAudio(sideA);
      await new Promise((r) => setTimeout(r, 1_200));
      await driverB.playAudio(sideB);

      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence during side conversation...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const bytesA = driverA.getReceivedAudioBytes();
      const bytesB = driverB.getReceivedAudioBytes();
      console.log(`[Dialogue] Side conversation — driverA: ${bytesA} bytes, driverB: ${bytesB} bytes`);

      assert.strictEqual(
        bytesA,
        0,
        `Bot should stay silent when speakers pivot to side conversation, but driverA got ${bytesA} bytes`
      );
      assert.strictEqual(
        bytesB,
        0,
        `Bot should stay silent when speakers pivot to side conversation, but driverB got ${bytesB} bytes`
      );
    },
    DEFAULT_TIMEOUT_MS
  );

  test(
    "Dialogue: Follow-up beyond engagement window — bot stays silent",
    async () => {
      if (!hasDialogueE2EConfig()) return;

      const responseWaitMs = envNumber("E2E_RESPONSE_WAIT_MS", 12_000);

      const addressFixture = await ensureFixture(
        "dialogue_a_stale_address",
        "Hey clanker, quick question, what's two plus two?"
      );
      const staleFollowup = await ensureFixture(
        "dialogue_a_stale_followup",
        "Oh wait, one more thing, never mind."
      );

      driverA.clearReceivedAudio();

      // Step 1: Address the bot
      console.log("[Dialogue] Speaker A addressing bot...");
      await driverA.playAudio(addressFixture);
      await new Promise((r) => setTimeout(r, responseWaitMs));

      assert.ok(
        driverA.getReceivedAudioBytes() > 0,
        "Bot must respond to the direct address"
      );

      // Step 2: Wait BEYOND the engagement window, then try a casual follow-up.
      // Add a safety margin so we're clearly past the window.
      const staleDelayMs = RECENT_ENGAGEMENT_WINDOW_MS + 8_000;
      console.log(`[Dialogue] Waiting ${staleDelayMs}ms to expire engagement window (${RECENT_ENGAGEMENT_WINDOW_MS}ms)...`);
      await new Promise((r) => setTimeout(r, staleDelayMs));

      driverA.clearReceivedAudio();

      console.log("[Dialogue] Speaker A attempting stale follow-up...");
      await driverA.playAudio(staleFollowup);

      console.log(`[Dialogue] Waiting ${SILENCE_WINDOW_MS}ms for bot silence...`);
      await new Promise((r) => setTimeout(r, SILENCE_WINDOW_MS));

      const staleBytes = driverA.getReceivedAudioBytes();
      console.log(`[Dialogue] Bot response to stale follow-up: ${staleBytes} bytes`);

      assert.strictEqual(
        staleBytes,
        0,
        `Bot should stay silent for a casual follow-up beyond the engagement window (${RECENT_ENGAGEMENT_WINDOW_MS}ms), but got ${staleBytes} bytes`
      );
    },
    // This test needs extra time because it deliberately waits past the engagement window
    DEFAULT_TIMEOUT_MS + RECENT_ENGAGEMENT_WINDOW_MS + 15_000
  );
});
