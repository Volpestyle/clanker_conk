import { appConfig } from "../../../src/config.ts";
import { LLMService } from "../../../src/llm.ts";

class HarnessStore {
  logAction() {
    // Harness reporting writes directly to stdout/json payloads.
  }
}

export function createReplayLlmService() {
  return new LLMService({
    appConfig,
    store: new HarnessStore()
  });
}
