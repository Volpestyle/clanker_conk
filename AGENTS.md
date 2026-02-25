# Repository Instructions

- Always remove legacy compatibility paths and dead code as part of the same change.
- Do not keep backward-compatibility shims, aliases, or old-field fallbacks unless the user explicitly asks for them.
- Prefer a single source of truth over parallel old/new code paths.
- After refactors, delete unused settings, branches, helpers, and UI wiring instead of leaving dormant code behind.
- Pull inspiration from ../openclaw when designing and coding agentic capabilites for clanker conk