# Public HTTPS Entrypoint Spec

Updated: February 27, 2026

## Goal
Create a first-class way to expose the local dashboard/API (`localhost:8787`) over public HTTPS so remote users can open share links and send stream frames to the bot process.

## Scope
- Add optional runtime-managed public HTTPS entrypoint via Cloudflare Quick Tunnel (`cloudflared`).
- Expose tunnel state in API runtime responses.
- Provide operational knobs through environment variables.
- Keep frame ingest routes authenticated via either private admin token, public API token, or short-lived share-session token.

## Non-Goals
- Native Discord Go Live capture from bot APIs.
- Building a custom reverse proxy/TLS terminator.
- Replacing tunnel providers with a plugin system.

## Product Behavior

### 1. Optional Public HTTPS Runtime
When `PUBLIC_HTTPS_ENABLED=true`:
- Node process starts a child process:
  - `cloudflared tunnel --url <target> --no-autoupdate`
- The system watches child output and extracts a `https://*.trycloudflare.com` URL.
- On URL discovery, runtime state switches to `ready`.

When disabled:
- Runtime state remains `disabled`.
- No child process is created.

### 2. Health and State Exposure
API surfaces:
- `GET /api/public-https`
- `GET /api/stats` includes `runtime.publicHttps`

State shape:
```json
{
  "enabled": true,
  "provider": "cloudflared",
  "status": "ready",
  "targetUrl": "http://127.0.0.1:8787",
  "publicUrl": "https://example.trycloudflare.com",
  "pid": 12345,
  "startedAt": "2026-02-27T12:34:56.789Z",
  "lastError": ""
}
```

`status` values:
- `disabled`
- `idle`
- `starting`
- `ready`
- `error`
- `stopped`

### 3. Public/Private Route Gating
- Tunnel-host requests are treated as public ingress traffic.
- Public ingress allowlist is intentionally narrow:
  - `POST /api/voice/stream-ingest/frame`
  - tokenized `POST /api/voice/share-session/:token/frame`
  - tokenized `POST /api/voice/share-session/:token/stop`
  - `GET /share/:token`
- Non-allowlisted API routes on tunnel host return `404`.
- Dashboard UI/static routes on tunnel host return `404` unless they are tokenized share pages.
- Public header-token routes require `x-public-api-token` matching `PUBLIC_API_TOKEN`.
- Private/local admin routes require `x-dashboard-token` when public HTTPS is enabled.
- Dashboard/API listener defaults to loopback host (`127.0.0.1`) unless explicitly overridden.

### 4. Failure Handling
- If `cloudflared` is missing or exits unexpectedly:
  - state becomes `error`
  - action log records `bot_error`
  - automatic retry runs after a short delay

### 5. Shutdown Behavior
- On process shutdown:
  - bot disconnects
  - public HTTPS child process receives termination signal
  - dashboard server closes

## Configuration

Environment variables:
- `PUBLIC_HTTPS_ENABLED` (`true|false`, default `false`)
- `PUBLIC_HTTPS_PROVIDER` (currently `cloudflared`)
- `PUBLIC_HTTPS_TARGET_URL` (optional, default `http://127.0.0.1:${DASHBOARD_PORT}`)
- `PUBLIC_HTTPS_CLOUDFLARED_BIN` (optional, default `cloudflared`)
- `PUBLIC_API_TOKEN` (required for public header-token API routes)
- `DASHBOARD_HOST` (optional bind host, default `127.0.0.1`)
- `DASHBOARD_TOKEN` (required for private/admin APIs when `PUBLIC_HTTPS_ENABLED=true`)

## Security Model
- Public HTTPS entrypoint does not bypass API auth.
- Stream ingest endpoint requires either private admin auth (`DASHBOARD_TOKEN`) or public ingress auth (`PUBLIC_API_TOKEN`).
- Operators should treat tunnel URL as untrusted public entrypoint and keep token secret.

## Observability
- Action stream includes:
  - `public_https_entrypoint_starting` (`bot_runtime`)
  - `public_https_entrypoint_ready` (`bot_runtime`)
  - spawn/exit/log failures (`bot_error`)
- Dashboard metrics include a `Public HTTPS` card showing current state/URL host.

## Runbook
1. Install `cloudflared`.
2. Set `.env`:
   - `PUBLIC_HTTPS_ENABLED=true`
   - optionally `DASHBOARD_TOKEN=<strong secret>`
3. Start bot: `npm run start`.
4. Confirm tunnel:
   - dashboard `Public HTTPS` metric, or
   - `GET /api/public-https`.
5. Use returned HTTPS origin for remote share workflows.
