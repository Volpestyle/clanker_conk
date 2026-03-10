import assert from "node:assert/strict";
import { test } from "bun:test";
import { loadConversationContinuityContext } from "./conversationContinuity.ts";

test("loadConversationContinuityContext still loads fact profiles for text-light turns", async () => {
  let factProfileCalls = 0;
  let historyCalls = 0;

  const continuity = await loadConversationContinuityContext({
    settings: {
      memory: {
        enabled: true
      }
    },
    guildId: "guild-1",
    channelId: "chan-1",
    userId: "user-1",
    queryText: "",
    recentMessages: [
      {
        author_id: "user-1",
        author_name: "Alice"
      }
    ],
    loadFactProfile(payload) {
      factProfileCalls += 1;
      assert.equal(payload.guildId, "guild-1");
      assert.equal(payload.userId, "user-1");
      return {
        participantProfiles: [
          {
            userId: "user-1",
            displayName: "Alice",
            facts: [{ fact: "likes tea" }]
          }
        ],
        userFacts: [{ fact: "likes tea" }],
        relevantFacts: []
      };
    },
    loadRecentConversationHistory() {
      historyCalls += 1;
      return [];
    }
  });

  assert.equal(factProfileCalls, 1);
  assert.equal(historyCalls, 0);
  assert.equal(continuity.memorySlice.userFacts.length, 1);
  assert.equal(continuity.memorySlice.userFacts[0]?.fact, "likes tea");
});
