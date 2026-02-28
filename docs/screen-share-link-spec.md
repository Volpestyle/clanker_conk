# Screen Share Link Spec

Updated: February 28, 2026

## Goal
Let the bot send a temporary clickable link in Discord that opens a browser screen-share page and streams frames to the bot voice session.

## UX Flow
1. User asks the bot to look at their screen (or model decides a visual would help).
2. Reply model sets `screenShareIntent.action=offer_link`.
3. Bot creates a short-lived tokenized share session.
4. Bot replies with a tokenized share URL:
   - local fallback: `http://127.0.0.1:<DASHBOARD_PORT>/share/<token>`
   - public tunnel (when enabled): `https://.../share/<token>`
5. User opens link and clicks `Start Sharing`.
6. Browser captures display frames and posts them to `/api/voice/share-session/:token/frame`.
7. Bot ingests frames through existing stream-watch flow and comments in VC.

## Scope
- Structured reply support for `screenShareIntent`.
- Tokenized share-session manager with TTL.
- Public share page route (`/share/:token`).
- Token-auth frame ingest endpoints.
- Programmatic `watch_stream` arm on valid share session creation.

## Guardrails
- Share sessions expire automatically (default 12 minutes).
- Session creation requires current VC policy to pass:
  - active voice session in guild
  - requester in same VC
  - stream watch enabled
  - `voice.mode` supports stream-watch commentary:
    `openai_realtime`, `gemini_realtime`, or `voice_agent` with a configured vision fallback provider
- Frame ingest revalidates requester/target VC presence and auto-stops the share session if either leaves.
- Public ingress route-gating and token/header auth rules are defined in `docs/public-https-entrypoint-spec.md`.
- When public HTTPS is disabled, share links are localhost-only and intended for the machine running the bot.

## Endpoints
- `POST /api/voice/share-session` (create tokenized session, admin/private auth path)
- `POST /api/voice/share-session/:token/frame` (token route)
- `POST /api/voice/share-session/:token/stop` (token route)
- `GET /share/:token` (browser capture page)

## Security Model
- Share-session token is capability-style auth for that single session route only.
- `PUBLIC_API_TOKEN` is still supported for direct frame-ingest routes outside share-session token URLs.
- `DASHBOARD_TOKEN` remains admin/private API auth.
