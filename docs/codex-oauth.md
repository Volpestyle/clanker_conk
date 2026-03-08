# Codex OAuth Provider (`codex-oauth`)

## Overview

The `codex-oauth` provider authenticates with ChatGPT/OpenAI OAuth tokens instead of a standard OpenAI API key. It is intended to let a signed-in ChatGPT Plus/Pro account power Codex-style and OpenAI-style calls inside clanker conk.

This provider is experimental. It follows the same ChatGPT-backed Codex transport pattern used by `opencode`, not the normal public OpenAI API billing path.

## How It Works

### Authentication Flow

1. One-time OAuth 2.0 PKCE login against `auth.openai.com`
2. Tokens are stored in `data/codex-oauth-tokens.json`
3. Access tokens are refreshed automatically from the refresh token
4. Requests are sent with bearer auth plus the ChatGPT account id

### Transport Layer

The custom fetch wrapper rewrites OpenAI Responses API requests onto the ChatGPT Codex backend:

- `/v1/responses` -> `https://chatgpt.com/backend-api/codex/responses`
- `Authorization: Bearer <access_token>`
- `ChatGPT-Account-Id: <account_id>`
- `originator: clanker_conk`

For code-agent usage, legacy API model aliases like `codex-mini-latest` and `gpt-5-codex` are remapped to `gpt-5.3-codex` when this OAuth transport is active.

## Setup

### One-time login

Run:

```sh
bun scripts/codex-oauth-login.ts
```

This starts a local callback server, opens the browser login flow, then writes tokens to `data/codex-oauth-tokens.json`.

### Environment bootstrap

You can also seed the refresh token manually:

```env
CODEX_OAUTH_REFRESH_TOKEN=your-refresh-token
DEFAULT_PROVIDER=codex-oauth
DEFAULT_MODEL_CODEX_OAUTH=gpt-5.4
```

## Usage

Use `provider: "codex-oauth"` in settings with a supported model such as:

```json
{
  "provider": "codex-oauth",
  "model": "gpt-5.4"
}
```

For dev-team code-agent tasks, the `codex` worker will prefer `OPENAI_API_KEY` when present and otherwise fall back to the `codex-oauth` client.

## Pricing

Usage is tracked as zero-cost in the local pricing table because it is expected to be covered by the ChatGPT subscription rather than API billing.

## Reverse-Engineered From

This implementation is based on the `opencode` Codex provider approach:

- OAuth issuer: `https://auth.openai.com`
- ChatGPT Codex backend: `https://chatgpt.com/backend-api/codex/responses`
- Account-scoped bearer requests with `ChatGPT-Account-Id`

Treat this provider as experimental and isolated from the standard `openai` API-key path.
