import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserManager } from "../services/BrowserManager.ts";

interface BrowserOpenParams { url: string }
interface BrowserSnapshotParams { interactive_only?: boolean }
interface BrowserClickParams { ref: string }
interface BrowserTypeParams { ref: string; text: string; pressEnter?: boolean }
interface BrowserScrollParams { direction: "up" | "down"; pixels?: number }
interface BrowserExtractParams { ref?: string }

type BrowserToolParams =
  | BrowserOpenParams
  | BrowserSnapshotParams
  | BrowserClickParams
  | BrowserTypeParams
  | BrowserScrollParams
  | BrowserExtractParams
  | Record<string, never>;

export const BROWSER_AGENT_TOOL_DEFINITIONS: Array<{
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}> = [
  {
    name: "browser_open",
    description: "Opens a URL in the headless browser and returns the initial snapshot. Always use this first before interacting with a page.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The fully qualified URL to open (e.g. https://example.com)" }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_snapshot",
    description: "Takes a snapshot of the current page's accessibility tree, showing interactive elements with refs (e.g. @e1).",
    input_schema: {
      type: "object",
      properties: {
        interactive_only: {
          type: "boolean",
          description: "If true, only returns interactive elements. Default true."
        }
      }
    }
  },
  {
    name: "browser_click",
    description: "Clicks an element on the active page via its reference ID. Returns the new snapshot after the click.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The reference ID of the element (e.g. @e4)" }
      },
      required: ["ref"]
    }
  },
  {
    name: "browser_type",
    description: "Types text into an input element.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The reference ID of the input field (e.g. @e2)" },
        text: { type: "string", description: "The text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing (default true)" }
      },
      required: ["ref", "text"]
    }
  },
  {
    name: "browser_scroll",
    description: "Scrolls the page up or down.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
        pixels: { type: "number", description: "Pixels to scroll (default 800)" }
      },
      required: ["direction"]
    }
  },
  {
    name: "browser_extract",
    description: "Extracts raw text content from the page or a specific element.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Optional element reference. Omit for full page text." }
      }
    }
  },
  {
    name: "browser_close",
    description: "Force closes the browser session.",
    input_schema: {
      type: "object",
      properties: {}
    }
  }
];

export async function executeBrowserTool(
  browserManager: BrowserManager,
  sessionKey: string,
  toolName: string,
  params: BrowserToolParams
): Promise<string> {
  try {
    switch (toolName) {
      case "browser_open":
        return await browserManager.open(sessionKey, (params as BrowserOpenParams).url);
      case "browser_snapshot":
        return await browserManager.snapshot(sessionKey, (params as BrowserSnapshotParams).interactive_only !== false);
      case "browser_click":
        return await browserManager.click(sessionKey, (params as BrowserClickParams).ref);
      case "browser_type": {
        const p = params as BrowserTypeParams;
        return await browserManager.type(sessionKey, p.ref, p.text, p.pressEnter !== false);
      }
      case "browser_scroll": {
        const p = params as BrowserScrollParams;
        return await browserManager.scroll(sessionKey, p.direction, p.pixels);
      }
      case "browser_extract":
        return await browserManager.extract(sessionKey, (params as BrowserExtractParams).ref);
      case "browser_close":
        await browserManager.close(sessionKey);
        return "Browser closed successfully.";
      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error executing ${toolName}: ${message}`;
  }
}
