import type { DashboardAppConfig, DashboardBot } from "../dashboard.ts";
import type { DashboardApp } from "./shared.ts";
import type { Store } from "../store/store.ts";
import {
  buildAuthorizeUrl as buildOpenAiAuthorizeUrl,
  codexOAuthConstants,
  exchangeCodeForTokens as exchangeOpenAiCode,
  isCodexOAuthConfigured
} from "../llm/codexOAuth.ts";
import {
  buildAuthorizeUrl as buildClaudeAuthorizeUrl,
  exchangeCodeForTokens as exchangeClaudeCode,
  isClaudeOAuthConfigured
} from "../llm/claudeOAuth.ts";
import { readDashboardBody } from "./shared.ts";

interface OAuthRouteDeps {
  store: Store;
  appConfig: DashboardAppConfig;
  bot: DashboardBot;
}

// In-memory pending OAuth sessions. Keyed by state (OpenAI) or session ID (Claude).
// These are short-lived — cleared after completion or after 10 minutes.
const PENDING_TTL_MS = 10 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type PendingClaudeSession = {
  verifier: string;
  state: string;
  provider: "claude";
  createdAt: number;
};

const pendingClaudeSessions = new Map<string, PendingClaudeSession>();

// Track the active OpenAI callback server so we don't spin up duplicates.
let activeOpenAiCallbackServer: {
  server: ReturnType<typeof Bun.serve>;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of pendingClaudeSessions) {
    if (now - session.createdAt > PENDING_TTL_MS) {
      pendingClaudeSessions.delete(key);
    }
  }
}

/**
 * Spins up a temporary HTTP server on the registered OAuth callback port (1455)
 * to receive the OpenAI redirect. The server shuts itself down after handling
 * the callback or after 5 minutes — whichever comes first.
 *
 * We must use the registered redirect URI (http://localhost:1455/auth/callback)
 * because OpenAI rejects unregistered redirect URIs at the authorize endpoint.
 */
function startOpenAiCallbackServer(
  store: Store,
  verifier: string,
  state: string,
  dashboardPort: number,
  onSuccess?: () => void
): void {
  // Tear down any previous server that's still hanging around.
  stopOpenAiCallbackServer();

  const redirectUri = codexOAuthConstants.defaultRedirectUri;
  const dashboardUrl = `http://localhost:${dashboardPort}`;

  const server = Bun.serve({
    port: codexOAuthConstants.defaultCallbackPort,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== "/auth/callback") {
        return new Response("Not found", { status: 404 });
      }

      const code = String(requestUrl.searchParams.get("code") || "").trim();
      const returnedState = String(requestUrl.searchParams.get("state") || "").trim();
      const error = String(requestUrl.searchParams.get("error") || "").trim();
      const errorDescription = String(requestUrl.searchParams.get("error_description") || "").trim();

      // Always shut down after handling the callback.
      setTimeout(() => stopOpenAiCallbackServer(), 500);

      if (error) {
        store.logAction({
          kind: "dashboard",
          content: "oauth_openai_callback_error",
          metadata: { error, errorDescription }
        });
        return new Response(
          oauthResultPage("OpenAI", false, `OAuth error: ${error}. ${errorDescription}`, dashboardUrl),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (!code) {
        return new Response(
          oauthResultPage("OpenAI", false, "Missing authorization code.", dashboardUrl),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (returnedState !== state) {
        return new Response(
          oauthResultPage("OpenAI", false, "OAuth state mismatch. Try authenticating again.", dashboardUrl),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      try {
        await exchangeOpenAiCode({ code, redirectUri, verifier });
        store.logAction({ kind: "dashboard", content: "oauth_openai_completed" });
        // Hot-reload the OAuth client in the running LLMService.
        try { onSuccess?.(); } catch { /* best-effort */ }
        return new Response(
          oauthResultPage("OpenAI", true, "Authentication successful. You can close this tab and return to the dashboard.", dashboardUrl),
          { headers: { "Content-Type": "text/html" } }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.logAction({
          kind: "dashboard",
          content: "oauth_openai_exchange_failed",
          metadata: { error: message }
        });
        return new Response(
          oauthResultPage("OpenAI", false, `Token exchange failed: ${message}`, dashboardUrl),
          { headers: { "Content-Type": "text/html" } }
        );
      }
    }
  });

  const timeout = setTimeout(() => {
    stopOpenAiCallbackServer();
    store.logAction({ kind: "dashboard", content: "oauth_openai_callback_timeout" });
  }, CALLBACK_TIMEOUT_MS);

  activeOpenAiCallbackServer = { server, timeout };
}

function stopOpenAiCallbackServer() {
  if (!activeOpenAiCallbackServer) return;
  clearTimeout(activeOpenAiCallbackServer.timeout);
  try { activeOpenAiCallbackServer.server.stop(); } catch { /* already stopped */ }
  activeOpenAiCallbackServer = null;
}

export function attachOAuthRoutes(app: DashboardApp, deps: OAuthRouteDeps) {
  const { store, appConfig, bot } = deps;
  const reloadOAuth = () => { void bot.reloadOAuthProviders?.(); };

  // ── Status ────────────────────────────────────────────────────────
  app.get("/api/oauth/status", (c) => {
    return c.json({
      claude_oauth: isClaudeOAuthConfigured(appConfig.claudeOAuthRefreshToken || ""),
      openai_oauth: isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || "")
    });
  });

  // ── OpenAI OAuth: Initiate ────────────────────────────────────────
  // Uses the registered redirect URI (localhost:1455) with a temporary
  // callback server, matching the login script's approach.
  app.post("/api/oauth/openai/initiate", (c) => {
    const redirectUri = codexOAuthConstants.defaultRedirectUri;
    const { url, verifier, state } = buildOpenAiAuthorizeUrl({ redirectUri });

    try {
      startOpenAiCallbackServer(store, verifier, state, appConfig.dashboardPort, reloadOAuth);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.logAction({
        kind: "dashboard",
        content: "oauth_openai_callback_server_failed",
        metadata: { error: message }
      });
      return c.json({
        error: `Failed to start OAuth callback server on port ${codexOAuthConstants.defaultCallbackPort}: ${message}`
      }, 503);
    }

    store.logAction({
      kind: "dashboard",
      content: "oauth_openai_initiated",
      metadata: { redirectUri, callbackPort: codexOAuthConstants.defaultCallbackPort }
    });

    return c.json({ url, state });
  });

  // ── Claude OAuth: Initiate ────────────────────────────────────────
  app.post("/api/oauth/claude/initiate", (c) => {
    cleanExpiredSessions();

    const { url, verifier } = buildClaudeAuthorizeUrl();
    // Claude uses the verifier as the state parameter in its URL.
    // We generate a session key for the dashboard to reference.
    const sessionKey = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    pendingClaudeSessions.set(sessionKey, {
      verifier,
      state: sessionKey,
      provider: "claude",
      createdAt: Date.now()
    });

    store.logAction({
      kind: "dashboard",
      content: "oauth_claude_initiated"
    });

    return c.json({ url, sessionKey });
  });

  // ── Claude OAuth: Complete (user pastes code) ─────────────────────
  app.post("/api/oauth/claude/complete", async (c) => {
    const body = await readDashboardBody(c);
    const code = String(body.code || "").trim();
    const sessionKey = String(body.sessionKey || "").trim();

    if (!code || !sessionKey) {
      return c.json({ error: "code and sessionKey are required" }, 400);
    }

    const session = pendingClaudeSessions.get(sessionKey);
    if (!session || session.provider !== "claude") {
      return c.json({ error: "Unknown or expired OAuth session. Try authenticating again." }, 400);
    }
    pendingClaudeSessions.delete(sessionKey);

    try {
      await exchangeClaudeCode(code, session.verifier);
      store.logAction({
        kind: "dashboard",
        content: "oauth_claude_completed"
      });
      reloadOAuth();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.logAction({
        kind: "dashboard",
        content: "oauth_claude_exchange_failed",
        metadata: { error: message }
      });
      return c.json({ error: `Token exchange failed: ${message}` }, 502);
    }
  });
}

// Minimal HTML page for the OpenAI OAuth callback redirect.
function oauthResultPage(provider: string, success: boolean, message: string, dashboardUrl = ""): string {
  const color = success ? "#4ade80" : "#f87171";
  const title = success ? `${provider} OAuth Complete` : `${provider} OAuth Failed`;
  const dashboardLink = dashboardUrl
    ? `<p style="margin-top:1rem"><a href="${dashboardUrl}" style="color:${success ? "#4ade80" : "#94a3b8"}">Return to dashboard</a></p>`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      background: #0a1412;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      text-align: center;
      padding: 2rem 3rem;
      border: 1px solid ${color}40;
      border-radius: 12px;
      background: ${color}08;
      max-width: 480px;
    }
    h1 { color: ${color}; font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
    a { text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    ${dashboardLink}
  </div>
</body>
</html>`;
}
