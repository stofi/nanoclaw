# Intent: src/index.ts modifications

## What changed
Added claw-chat WebChannel alongside WhatsApp. WebChannel polls the claw-chat Nuxt app
over HTTP, delivers messages to the orchestrator, and posts agent responses back.

## Key sections

### Imports (top of file)
- Added: `WebChannel` from `./channels/web.js`
- Added: `WEBUI_ONLY` from `./config.js`
- Added: `readEnvFile` from `./env.js` (for checking WEBUI_INTERNAL_SECRET at startup)
- Kept: all existing imports unchanged

### Module-level state
- Kept: `let whatsapp: WhatsAppChannel` — still needed for IPC `syncGroupMetadata`
- Added: `let web: WebChannel | undefined` — direct reference, mirrors the slack pattern
- Kept: `const channels: Channel[]` — multi-channel array used by `findChannel`

### registerGroup()
- Unchanged from base. WebChannel calls this directly via `opts.registerGroup` to
  auto-register conversations when they first appear in `/api/internal/pending`.
- WebChannel is the only channel that receives a `registerGroup` callback in its opts,
  because claw-chat conversations are created in the WebUI and must auto-register.

### main()
- Added: reads `WEBUI_INTERNAL_SECRET` via `readEnvFile()` to check if claw-chat is configured.
  The secret itself is NOT stored in a variable — just used for the boolean check. WebChannel
  reads it again internally (same double-read pattern as Slack tokens).
- Added: conditional WhatsApp creation: `if (!WEBUI_ONLY)` — skips WhatsApp when running
  claw-chat as the sole channel.
- Added: conditional WebChannel creation: `if (hasWebuiSecret)` — only active when
  `WEBUI_INTERNAL_SECRET` is set in `.env`.
- Kept: `syncGroupMetadata` in IPC watcher calls `whatsapp?.syncGroupMetadata(force)`.
  WebChannel has no metadata to sync (conversations are managed by claw-chat), so the
  optional chaining handles the WEBUI_ONLY case gracefully.

### Shutdown handler
- Kept: `for (const ch of channels) await ch.disconnect()` — already disconnects all
  channels including WebChannel.

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged

## Design decisions

### registerGroup passed into WebChannelOpts
Unlike Slack/Discord (where channels are pre-registered manually), claw-chat conversations
are created in the WebUI and flow into NanoClaw as registrations via `/api/internal/pending`.
WebChannel auto-registers them by calling `registerGroup(jid, group)` directly.
This is safe because claw-chat controls the `folder` name (format: `web-XXXXXXXX`) which
passes `resolveGroupFolderPath` validation.

### Double readEnvFile for WEBUI_INTERNAL_SECRET
`main()` reads `WEBUI_INTERNAL_SECRET` to decide whether to instantiate WebChannel.
WebChannel's constructor reads it again independently. Intentional — same pattern as Slack.

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The `resolveGroupFolderPath` validation in `registerGroup`
