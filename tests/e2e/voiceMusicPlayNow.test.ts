import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  beginTemporaryE2EEagerness50,
  DriverBot,
  type DriverBotConfig,
  getE2EConfig,
  hasE2EConfig,
  hasDialogueE2EConfig,
  getFixturePath,
  generatePcmAudioFixture,
  restoreTemporaryE2ESettings
} from "./driver/index.ts";

function envFlag(name: string, defaultValue = false): boolean {
  const value = env[name];
  if (value === undefined) return defaultValue;
  return value === "1" || value === "true" || value === "yes";
}

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const SKIP_MSG = "Skipping music play-now E2E tests: set RUN_E2E_MUSIC=1";

/**
 * Non-blocking music_play_now E2E tests.
 *
 * Validates that when a user asks to play music via voice, the bot
 * acknowledges immediately (within a few seconds) rather than blocking
 * for the full yt-dlp download (~17s).
 *
 * Tests are consolidated into multi-phase scenarios that chain related
 * assertions to avoid redundant download/stop cycles (~30s each).
 *
 * Requires: RUN_E2E_MUSIC=1 and standard E2E env vars.
 */
describe("E2E: Voice music_play_now (non-blocking)", () => {
  let driver: DriverBot;
  let driverB: DriverBot | null = null;

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

  /** Wait for clanker to finish speaking, then clear the audio buffer. */
  async function settleAndClear(settleMs = 3_000): Promise<void> {
    await new Promise((r) => setTimeout(r, settleMs));
    driver.clearReceivedAudio();
    driverB?.clearReceivedAudio();
  }

  async function stopMusic(): Promise<void> {
    const stopFixture = await ensureFixture(
      "music_stop_voice",
      "Hey clanker, stop the music"
    );
    driver.clearReceivedAudio();
    await driver.playAudio(stopFixture);
    await driver.waitForAudioResponse(10_000);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  beforeAll(async () => {
    if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) {
      console.log(SKIP_MSG);
      return;
    }

    const config = getE2EConfig();
    await beginTemporaryE2EEagerness50();

    const baseConfig = {
      guildId: config.testGuildId,
      voiceChannelId: config.testVoiceChannelId,
      textChannelId: config.testTextChannelId,
      systemBotUserId: config.systemBotUserId
    };

    driver = new DriverBot({ ...baseConfig, token: config.driverBotToken });
    await driver.connect();
    await driver.joinVoiceChannel();

    // Connect second driver bot if available (needed for chatter resilience test)
    if (hasDialogueE2EConfig()) {
      try {
        const b = new DriverBot({ ...baseConfig, token: config.driverBot2Token });
        await b.connect();
        await b.joinVoiceChannel();
        driverB = b;
      } catch (err) {
        console.log(`[Music] Driver B failed to join voice, chatter test will skip: ${(err as Error).message}`);
        driverB = null;
      }
    }

    await driver.summonSystemBot(45_000);
  }, 120_000);

  afterAll(async () => {
    // Safety cleanup — stop any lingering music
    try { await stopMusic(); } catch { /* ignore */ }
    try { await driver?.dismissBot("dismiss_music", "Yo clanker, thanks for the tunes, you can bounce now!"); } catch { /* ignore */ }
    await Promise.all([
      driver?.destroy(),
      driverB?.destroy()
    ]);
    await restoreTemporaryE2ESettings();
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────
  // Test 1: Full lifecycle + duck in/out
  //
  // Phases:
  //   A) Request song, verify fast ack + now-playing notification
  //   B) Direct address during playback — duck in, respond, duck out
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Full lifecycle — fast ack, now-playing, duck in/out",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      const maxAckMs = envNumber("E2E_MUSIC_ACK_MAX_MS", 8_000);
      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      const playFixture = await ensureFixture(
        "music_play_request",
        "Hey clanker, play Bad and Boujee by Migos"
      );
      const whoSingsFixture = await ensureFixture(
        "music_who_sings",
        "Hey clanker, who sings this song?"
      );

      // ── Phase A: Request song, verify fast ack (non-blocking) ──

      await settleAndClear(3_000);

      console.log("[Lifecycle] Playing music request...");
      await driver.playAudio(playFixture);

      const start = Date.now();
      const gotAck = await driver.waitForAudioResponse(maxAckMs);
      const ackMs = Date.now() - start;
      console.log(`[Lifecycle] Ack: ${gotAck ? "yes" : "no"} (${ackMs}ms)`);

      assert.ok(gotAck, `Bot should ack within ${maxAckMs}ms (got no audio — tool may still be blocking)`);
      assert.ok(ackMs < maxAckMs, `Ack latency ${ackMs}ms exceeds ${maxAckMs}ms`);

      const ackBytes = driver.getReceivedAudioBytes();

      // Wait for download, verify "now playing" notification
      console.log(`[Lifecycle] Waiting ${downloadWaitMs}ms for download + now-playing...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const postDownloadBytes = driver.getReceivedAudioBytes();
      console.log(`[Lifecycle] Audio — ack: ${ackBytes}, postDownload: ${postDownloadBytes}`);

      assert.ok(
        postDownloadBytes > ackBytes,
        `Expected "now playing" notification after download. Ack: ${ackBytes}, total: ${postDownloadBytes}`
      );

      // ── Phase B: Duck in/out — direct address during playback ──

      // Music is still playing from phase A
      await settleAndClear(3_000);

      console.log("[DuckInOut] Asking 'who sings this song?'...");
      await driver.playAudio(whoSingsFixture);

      const gotResponse = await driver.waitForAudioResponse(10_000);
      const responseBytes = driver.getReceivedAudioBytes();
      console.log(`[DuckInOut] Response: ${gotResponse ? "yes" : "no"} (${responseBytes} bytes)`);

      assert.ok(gotResponse, "Bot should respond to direct address during music playback");

      // Wait for bot to finish speaking, then verify music continues
      await new Promise((r) => setTimeout(r, 5_000));
      driver.clearReceivedAudio();
      await new Promise((r) => setTimeout(r, 5_000));
      const musicResumeBytes = driver.getReceivedAudioBytes();
      console.log(`[DuckInOut] Music resume: ${musicResumeBytes} bytes after bot response`);

      assert.ok(musicResumeBytes > 0, "Music should continue playing after bot responds (duck out)");

      await stopMusic();
    },
    180_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 2: Song replacement — pre-download backtrack + mid-playback swap
  //
  // Phases:
  //   A) Request song A, replace with B within 1s (before download)
  //   B) Let B download + play, then replace with C mid-playback
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Song replacement — pre-download backtrack, then mid-playback swap",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      const [songA, songB, songC] = await Promise.all([
        ensureFixture("music_replace_a", "Hey clanker, play Bohemian Rhapsody by Queen"),
        ensureFixture("music_replace_b", "Hey clanker, actually play Lose Yourself by Eminem instead"),
        ensureFixture("music_replace_c", "Hey clanker, play Sunflower by Post Malone instead")
      ]);

      // ── Phase A: Pre-download replacement — request A, replace with B within 1s ──

      await settleAndClear(5_000);

      console.log("[Replace] Requesting song A...");
      await driver.playAudio(songA);

      const gotAckA = await driver.waitForAudioResponse(10_000);
      console.log(`[Replace] Song A ack: ${gotAckA ? "yes" : "no"} (${driver.getReceivedAudioBytes()} bytes)`);
      assert.ok(gotAckA, "Bot should ack first request");

      // Fire replacement within 1s — download hasn't finished yet
      await new Promise((r) => setTimeout(r, 1_000));
      driver.clearReceivedAudio();

      console.log("[Replace] Replacing with song B (pre-download)...");
      await driver.playAudio(songB);

      const gotAckB = await driver.waitForAudioResponse(10_000);
      const ackBBytes = driver.getReceivedAudioBytes();
      console.log(`[Replace] Song B ack: ${gotAckB ? "yes" : "no"} (${ackBBytes} bytes)`);
      assert.ok(gotAckB, "Bot should ack replacement request");

      // Wait for B to download and "now playing" to fire
      console.log(`[Replace] Waiting ${downloadWaitMs}ms for song B download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const postBDownloadBytes = driver.getReceivedAudioBytes();
      console.log(`[Replace] Post-download — ack: ${ackBBytes}, total: ${postBDownloadBytes}`);

      assert.ok(
        postBDownloadBytes > ackBBytes,
        `"Now playing" should fire for replacement track B. Ack: ${ackBBytes}, total: ${postBDownloadBytes}`
      );

      // ── Phase B: Mid-playback replacement — B is playing, swap to C ──

      // B is now playing. Verify we're receiving music audio.
      const preClearBytes = driver.getReceivedAudioBytes();
      assert.ok(preClearBytes > ackBBytes, "Song B should be actively playing");

      driver.clearReceivedAudio();

      console.log("[Replace] Replacing with song C (mid-playback)...");
      await driver.playAudio(songC);

      const gotAckC = await driver.waitForAudioResponse(10_000);
      const ackCBytes = driver.getReceivedAudioBytes();
      console.log(`[Replace] Song C ack: ${gotAckC ? "yes" : "no"} (${ackCBytes} bytes)`);
      assert.ok(gotAckC, "Bot should ack mid-playback replacement request");

      // Wait for C to download + "now playing"
      console.log(`[Replace] Waiting ${downloadWaitMs}ms for song C download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const postCDownloadBytes = driver.getReceivedAudioBytes();
      console.log(`[Replace] Post-download — ack: ${ackCBytes}, total: ${postCDownloadBytes}`);

      assert.ok(
        postCDownloadBytes > ackCBytes,
        `"Now playing" should fire for replacement track C. Ack: ${ackCBytes}, total: ${postCDownloadBytes}`
      );

      await stopMusic();
    },
    240_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 3: Disambiguation + chatter — bot stays locked on requester
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Disambiguation with background chatter — bot stays locked on requester's selection",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;
      if (!driverB) {
        console.log("[Music] Skipping disambiguation chatter test: no E2E_DRIVER_BOT_2_TOKEN");
        return;
      }

      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);

      // Pre-generate all fixtures in parallel.
      // "play Roses" is intentionally vague — could be Outkast, SAINt JHN, etc.
      const [
        vagueRequest,
        chatterB1,
        chatterA1,
        chatterB2,
        chatterA2,
        disambiguationReply
      ] = await Promise.all([
        ensureFixture("music_disambig_vague", "Hey clanker, play Roses"),
        ensureFixture("music_disambig_chatter_b1", "Hey have you tried that new ramen place on fifth street?"),
        ensureFixture("music_disambig_chatter_a1", "No not yet, is it any good? I heard mixed things about it."),
        ensureFixture("music_disambig_chatter_b2", "It's amazing honestly, the tonkotsu is the best I've had."),
        ensureFixture("music_disambig_chatter_a2", "Alright bet, let's go there for lunch tomorrow then."),
        ensureFixture("music_disambig_selection", "The first one")
      ]);

      // --- Phase 1: Vague music request → disambiguation ---
      await settleAndClear(5_000);

      console.log("[Disambig] Vague music request...");
      await driver.playAudio(vagueRequest);

      const gotResponse = await driver.waitForAudioResponse(15_000);
      assert.ok(gotResponse, "Bot should respond to vague request (disambiguation or direct play)");
      console.log(`[Disambig] Initial response: ${driver.getReceivedAudioBytes()} bytes`);

      // --- Phase 2: Chatter fires during disambiguation window ---
      // Other users are talking but not addressing clanker. He should stay
      // locked on Driver A's pending music request.
      console.log("[Disambig] Background chatter during disambiguation window...");

      await new Promise((r) => setTimeout(r, 500));
      console.log("[Disambig] Driver B chatter 1...");
      await driverB.playAudio(chatterB1);

      await new Promise((r) => setTimeout(r, 800));
      console.log("[Disambig] Driver A chatter 1 (NOT addressing clanker)...");
      await driver.playAudio(chatterA1);

      await new Promise((r) => setTimeout(r, 800));
      console.log("[Disambig] Driver B chatter 2...");
      await driverB.playAudio(chatterB2);

      // --- Phase 3: Chatter stops, Driver A disambiguates ---
      // Clear break from chatter before the disambiguation reply.
      await settleAndClear(3_000);

      console.log("[Disambig] Driver A: 'the first one'...");
      await driver.playAudio(disambiguationReply);

      const gotSelectionAck = await driver.waitForAudioResponse(10_000);
      const selectionAckBytes = driver.getReceivedAudioBytes();
      console.log(`[Disambig] Selection ack: ${gotSelectionAck ? "yes" : "no"} (${selectionAckBytes} bytes)`);

      // --- Phase 4: Chatter resumes after disambiguation ---
      await new Promise((r) => setTimeout(r, 500));
      console.log("[Disambig] Driver A chatter 2 (resumes talking to B)...");
      await driver.playAudio(chatterA2);

      assert.ok(
        gotSelectionAck,
        `Bot should ack disambiguation selection after chatter break (got ${selectionAckBytes} bytes)`
      );

      // --- Phase 5: Wait for download, verify "now playing" fires ---
      console.log(`[Disambig] Waiting ${downloadWaitMs}ms for download...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const totalBytes = driver.getReceivedAudioBytes();
      console.log(`[Disambig] Audio — selectionAck: ${selectionAckBytes}, total: ${totalBytes}`);

      assert.ok(
        totalBytes > selectionAckBytes,
        `Music flow should complete after disambiguation + chatter. ` +
        `Ack: ${selectionAckBytes}, total: ${totalBytes}`
      );

      await stopMusic();
    },
    120_000
  );

  // ─────────────────────────────────────────────────────────────────────
  // Test 4: Queue + skip + announcement interruption policy
  //
  // Phases:
  //   A) Play song A, queue song B, skip A — verify B starts
  //   B) During B's playback, Driver B interrupts — should be ignored
  //   C) Driver A interrupts — should get a response
  // ─────────────────────────────────────────────────────────────────────
  test(
    "Music: Queue, skip, and announcement interruption policy",
    async () => {
      if (!hasE2EConfig() || !envFlag("RUN_E2E_MUSIC")) return;

      const downloadWaitMs = envNumber("E2E_MUSIC_DOWNLOAD_WAIT_MS", 30_000);
      const needsDriverB = Boolean(driverB);

      const fixturePromises: Promise<string>[] = [
        ensureFixture("music_queue_skip_play", "Hey clanker, play Bad and Boujee by Migos"),
        ensureFixture("music_queue_skip_queue", "Hey clanker, queue up Sicko Mode by Travis Scott after this"),
        ensureFixture("music_queue_skip_skip", "Hey clanker, skip this song")
      ];
      if (needsDriverB) {
        fixturePromises.push(
          ensureFixture("music_announce_interrupt_b", "Hey clanker, what time is it right now?"),
          ensureFixture("music_announce_interrupt_a", "Hey clanker, who sings this song?")
        );
      }

      const fixtures = await Promise.all(fixturePromises);
      const [playRequest, queueRequest, skipRequest] = fixtures;
      const interruptB = fixtures[3];
      const interruptA = fixtures[4];

      // ── Phase A: Play song A, queue B, skip A — verify B starts ──

      await settleAndClear(5_000);

      console.log("[QueueSkip] Playing first song...");
      await driver.playAudio(playRequest);

      const gotPlayAck = await driver.waitForAudioResponse(10_000);
      console.log(`[QueueSkip] Play ack: ${gotPlayAck ? "yes" : "no"} (${driver.getReceivedAudioBytes()} bytes)`);
      assert.ok(gotPlayAck, "Bot should ack first play request");

      // Wait for first song to start playing
      console.log(`[QueueSkip] Waiting ${downloadWaitMs}ms for first song to start...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const playingBytes = driver.getReceivedAudioBytes();
      console.log(`[QueueSkip] First song playing: ${playingBytes} bytes`);
      assert.ok(playingBytes > 0, "First song should be playing");

      // Queue second song
      console.log("[QueueSkip] Queueing second song...");
      await driver.playAudio(queueRequest);

      const gotQueueAck = await driver.waitForAudioResponse(10_000);
      console.log(`[QueueSkip] Queue ack: ${gotQueueAck ? "yes" : "no"} (${driver.getReceivedAudioBytes()} bytes)`);
      assert.ok(gotQueueAck, "Bot should ack queue request");

      // Skip first song
      await settleAndClear(3_000);

      console.log("[QueueSkip] Skipping first song...");
      await driver.playAudio(skipRequest);

      const gotSkipAck = await driver.waitForAudioResponse(10_000);
      const skipAckBytes = driver.getReceivedAudioBytes();
      console.log(`[QueueSkip] Skip ack: ${gotSkipAck ? "yes" : "no"} (${skipAckBytes} bytes)`);
      assert.ok(gotSkipAck, "Bot should ack skip request");

      // Wait for second song to start playing
      console.log(`[QueueSkip] Waiting ${downloadWaitMs}ms for second song to start...`);
      await new Promise((r) => setTimeout(r, downloadWaitMs));

      const postSkipBytes = driver.getReceivedAudioBytes();
      console.log(`[QueueSkip] Post-skip bytes: ${postSkipBytes} (skipAck: ${skipAckBytes})`);

      assert.ok(
        postSkipBytes > skipAckBytes,
        `Second song should start after skip. Skip ack: ${skipAckBytes}, total: ${postSkipBytes}`
      );

      // ── Phase B: Announcement interruption — only requester can interrupt ──

      if (!needsDriverB) {
        console.log("[AnnounceInterrupt] Skipping interruption policy phase: no E2E_DRIVER_BOT_2_TOKEN");
        await stopMusic();
        return;
      }

      // Song B is playing (and/or its announcement just fired).
      // Driver B tries to interrupt — should be ignored.
      driver.clearReceivedAudio();
      driverB!.clearReceivedAudio();

      console.log("[AnnounceInterrupt] Driver B attempting interrupt...");
      await driverB!.playAudio(interruptB);

      // Give the bot time to potentially respond — it shouldn't
      const driverBGotResponse = await driverB!.waitForAudioResponse(8_000);
      const driverBBytes = driverB!.getReceivedAudioBytes();
      console.log(`[AnnounceInterrupt] Driver B response: ${driverBGotResponse ? "yes" : "no"} (${driverBBytes} bytes)`);

      const driverABytesAfterBInterrupt = driver.getReceivedAudioBytes();
      console.log(`[AnnounceInterrupt] Driver A bytes (same window): ${driverABytesAfterBInterrupt}`);

      // ── Phase C: Driver A interrupts — should get a response ──

      driver.clearReceivedAudio();
      driverB!.clearReceivedAudio();

      console.log("[AnnounceInterrupt] Driver A interrupting...");
      await driver.playAudio(interruptA);

      const driverAGotResponse = await driver.waitForAudioResponse(10_000);
      const driverAResponseBytes = driver.getReceivedAudioBytes();
      console.log(`[AnnounceInterrupt] Driver A response: ${driverAGotResponse ? "yes" : "no"} (${driverAResponseBytes} bytes)`);

      assert.ok(
        driverAGotResponse,
        "Requester (Driver A) should be able to interrupt during announcement"
      );

      // If Driver B received audio, it should be significantly less than A's
      // response — just background music bleed, not a dedicated response.
      if (driverBGotResponse) {
        console.log(
          `[AnnounceInterrupt] WARNING: Driver B received ${driverBBytes} bytes — ` +
          `checking it's just background music (Driver A got ${driverAResponseBytes} bytes)`
        );
        assert.ok(
          driverBBytes < driverAResponseBytes * 0.5,
          `Driver B should not get a dedicated response during announcement. ` +
          `B: ${driverBBytes}, A: ${driverAResponseBytes}`
        );
      }

      await stopMusic();
    },
    300_000
  );
});
