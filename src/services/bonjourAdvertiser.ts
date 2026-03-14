import { spawn, type ChildProcess } from "node:child_process";

const SERVICE_TYPE = "_clanky._tcp";
const SERVICE_NAME = "Clanky Dashboard";

/**
 * Advertises the Clanky dashboard via Bonjour/mDNS so the iOS app
 * can auto-discover it on the local network.
 *
 * Uses macOS `dns-sd` command — no dependencies needed.
 *
 * TXT record includes:
 *   - tunnelUrl: the current Cloudflare tunnel URL (updated live)
 *   - version: "1" (protocol version for future compat)
 *
 * The dashboard token is NOT advertised — the user still enters it manually.
 */
export class BonjourAdvertiser {
  private port: number;
  private child: ChildProcess | null = null;
  private tunnelUrl = "";
  private spawnFn: typeof spawn;

  constructor(port: number, deps?: { spawnFn?: typeof spawn }) {
    this.port = port;
    this.spawnFn = deps?.spawnFn ?? spawn;
  }

  start(tunnelUrl?: string): void {
    this.stop();
    this.tunnelUrl = tunnelUrl ?? "";
    if (!this.tunnelUrl) return;
    this.spawn();
  }

  /** Re-advertise with an updated tunnel URL (restarts dns-sd). */
  updateTunnelUrl(tunnelUrl: string): void {
    if (tunnelUrl === this.tunnelUrl) return;
    this.tunnelUrl = tunnelUrl;
    // dns-sd doesn't support updating TXT records in-place, so restart
    this.stop();
    if (!this.tunnelUrl) return;
    this.spawn();
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }

  private spawn(): void {
    // dns-sd -R <name> <type> <domain> <port> [key=value ...]
    const txtRecords = ["version=1"];
    if (this.tunnelUrl) {
      txtRecords.push(`tunnelUrl=${this.tunnelUrl}`);
    }

    const child = this.spawnFn(
      "dns-sd",
      ["-R", SERVICE_NAME, SERVICE_TYPE, ".", String(this.port), ...txtRecords],
      { stdio: "ignore", windowsHide: true }
    );
    this.child = child;

    child.on("error", () => {
      // dns-sd not available — silently degrade
      if (this.child === child) {
        this.child = null;
      }
    });

    child.on("close", () => {
      if (this.child === child) {
        this.child = null;
      }
    });
  }
}
