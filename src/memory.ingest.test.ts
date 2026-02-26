import assert from "node:assert/strict";
import test from "node:test";
import { MemoryManager } from "./memory.ts";

function createMemoryForIngestTests() {
  return new MemoryManager({
    store: {
      logAction() {
        return undefined;
      }
    },
    llm: {},
    memoryFilePath: "memory/MEMORY.md"
  });
}

test("ingestMessage awaits processing and dedupes queued message ids", async () => {
  const memory = createMemoryForIngestTests();
  memory.ingestWorkerActive = true;
  let processed = 0;
  memory.processIngestMessage = async () => {
    processed += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  const payload = {
    messageId: "ingest-1",
    authorId: "user-1",
    authorName: "user-1",
    content: "hello",
    settings: {},
    trace: { guildId: "guild-1" }
  };

  const first = memory.ingestMessage(payload);
  const second = memory.ingestMessage(payload);
  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(processed, 1);
});

test("queue overflow resolves dropped job as false", async () => {
  const memory = createMemoryForIngestTests();
  memory.maxIngestQueue = 1;
  memory.ingestWorkerActive = true;

  let processed = 0;
  memory.processIngestMessage = async () => {
    processed += 1;
    return undefined;
  };

  const first = memory.ingestMessage({
    messageId: "ingest-drop-1",
    authorId: "user-1",
    authorName: "user-1",
    content: "first",
    settings: {},
    trace: { guildId: "guild-1" }
  });
  const second = memory.ingestMessage({
    messageId: "ingest-drop-2",
    authorId: "user-2",
    authorName: "user-2",
    content: "second",
    settings: {},
    trace: { guildId: "guild-1" }
  });

  assert.equal(await first, false);

  memory.ingestWorkerActive = false;
  await memory.runIngestWorker();

  assert.equal(await second, true);
  assert.equal(processed, 1);
});
