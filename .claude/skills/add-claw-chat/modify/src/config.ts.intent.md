# Intent: src/config.ts modifications

## What changed
Added `WEBUI_ONLY` configuration export for the claw-chat WebChannel.

## Key sections

- **readEnvFile call**: Added `'WEBUI_ONLY'` to the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **WEBUI_ONLY**: Boolean flag — when `true`, WhatsApp channel is not started and claw-chat is the sole channel.
- **Note**: `WEBUI_URL` and `WEBUI_INTERNAL_SECRET` are NOT read here. They are read directly by `WebChannel` via `readEnvFile()` in `web.ts` to keep secrets off the config module (same pattern as `ANTHROPIC_API_KEY` in `container-runner.ts`).

## Invariants
- All existing config exports remain unchanged.
- The new key is appended to the `readEnvFile` array alongside existing keys.
- The new `WEBUI_ONLY` export is appended at the bottom of the file.
- No existing behavior is modified — the claw-chat config is purely additive.
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`).

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- The `os.homedir()` fallback in `HOME_DIR`
