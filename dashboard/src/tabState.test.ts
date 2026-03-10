import { test } from "bun:test";
import assert from "node:assert/strict";
import { loadStoredTab, saveStoredTab } from "./tabState.ts";

async function withMockLocalStorage(run: (storage: Map<string, string>) => Promise<void> | void) {
  const priorLocalStorage = globalThis.localStorage;
  const storage = new Map<string, string>();

  globalThis.localStorage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key) {
      return storage.has(String(key)) ? storage.get(String(key)) ?? null : null;
    },
    key(index) {
      const keys = [...storage.keys()];
      return keys[index] ?? null;
    },
    removeItem(key) {
      storage.delete(String(key));
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    }
  };

  try {
    await run(storage);
  } finally {
    globalThis.localStorage = priorLocalStorage;
  }
}

test("loadStoredTab returns the saved tab when it is allowed", async () => {
  await withMockLocalStorage((storage) => {
    storage.set("dashboard_main_tab", "voice");

    const tab = loadStoredTab("dashboard_main_tab", ["activity", "voice", "settings"] as const, "activity");

    assert.equal(tab, "voice");
  });
});

test("loadStoredTab falls back when storage is missing or invalid", async () => {
  await withMockLocalStorage((storage) => {
    storage.set("dashboard_main_tab", "nope");

    const invalidTab = loadStoredTab("dashboard_main_tab", ["activity", "voice", "settings"] as const, "activity");
    const missingTab = loadStoredTab("dashboard_memory_sub_tab", ["snapshot", "search"] as const, "snapshot");

    assert.equal(invalidTab, "activity");
    assert.equal(missingTab, "snapshot");
  });
});

test("saveStoredTab writes the selected tab to localStorage", async () => {
  await withMockLocalStorage((storage) => {
    saveStoredTab("dashboard_memory_sub_tab", "inspector");

    assert.equal(storage.get("dashboard_memory_sub_tab"), "inspector");
  });
});
