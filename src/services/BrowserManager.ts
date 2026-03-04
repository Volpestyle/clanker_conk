import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { assertPublicUrl } from "../urlSafety.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

interface BrowserSession {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
}

export class BrowserManager {
  private sessions: Map<string, BrowserSession> = new Map();
  private readonly maxConcurrentSessions: number;
  private readonly sessionTimeoutMs: number;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxConcurrentSessions?: number; sessionTimeoutMs?: number }) {
    this.maxConcurrentSessions = options?.maxConcurrentSessions || 2;
    this.sessionTimeoutMs = options?.sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;

    this.staleTimer = setInterval(() => {
      this.cleanupStaleSessions();
    }, STALE_CHECK_INTERVAL_MS);
  }

  private getOrCreateSession(sessionKey: string): BrowserSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent browser sessions (${this.maxConcurrentSessions}) exceeded.`);
    }
    const session: BrowserSession = {
      sessionKey,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  private touchSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) session.lastActiveAt = Date.now();
  }

  private runAgentBrowser(args: string[], timeoutMs = DEFAULT_STEP_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("agent-browser", args, { timeout: timeoutMs }).then(
      ({ stdout, stderr }) => ({ stdout: stdout.trim(), stderr: stderr.trim() }),
      (error: unknown) => {
        const err = error as { stderr?: string; stdout?: string; message?: string };
        const errMessage = err.stderr || err.stdout || err.message || "Unknown error executing agent-browser";
        throw new Error(`agent-browser error: ${errMessage}`);
      }
    );
  }

  async open(sessionKey: string, url: string): Promise<string> {
    await assertPublicUrl(url);
    this.getOrCreateSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(["open", url]);
    return stdout;
  }

  async snapshot(sessionKey: string, interactiveOnly = true): Promise<string> {
    this.touchSession(sessionKey);
    const args = interactiveOnly ? ["snapshot", "-i"] : ["snapshot"];
    const { stdout } = await this.runAgentBrowser(args);
    return stdout;
  }

  async click(sessionKey: string, ref: string): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(["click", ref]);
    return stdout;
  }

  async type(sessionKey: string, ref: string, text: string, pressEnter = true): Promise<string> {
    this.touchSession(sessionKey);
    const { stdout } = await this.runAgentBrowser(["type", ref, text]);
    if (pressEnter) {
      await this.runAgentBrowser(["enter"]);
    }
    return stdout;
  }

  async scroll(sessionKey: string, direction: "up" | "down", pixels?: number): Promise<string> {
    this.touchSession(sessionKey);
    const cmd = direction === "up" ? "scroll-up" : "scroll-down";
    const args = pixels ? [cmd, String(pixels)] : [cmd];
    const { stdout } = await this.runAgentBrowser(args);
    return stdout;
  }

  async extract(sessionKey: string, ref?: string): Promise<string> {
    this.touchSession(sessionKey);
    if (ref) {
      const { stdout } = await this.runAgentBrowser(["extract", ref]);
      return stdout;
    }
    return await this.snapshot(sessionKey, false);
  }

  async close(sessionKey: string): Promise<void> {
    try {
      await this.runAgentBrowser(["close"]);
    } catch {
      // ignore close errors
    } finally {
      this.sessions.delete(sessionKey);
    }
  }

  async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.close(key).catch(() => undefined);
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt > this.sessionTimeoutMs) {
        this.close(key).catch(() => undefined);
      }
    }
  }
}
