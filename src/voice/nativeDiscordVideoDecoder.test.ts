import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  decodeNativeDiscordVideoFrameToStillImage,
  hasNativeDiscordVideoDecoderSupport
} from "./nativeDiscordVideoDecoder.ts";

test("hasNativeDiscordVideoDecoderSupport returns a boolean", () => {
  const result = hasNativeDiscordVideoDecoderSupport();
  assert.equal(typeof result, "boolean");
});
