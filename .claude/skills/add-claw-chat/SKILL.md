---
name: add-claw-chat
description: Add claw-chat as a channel. A self-hosted Nuxt web UI that replaces third-party messaging services. Communicates with NanoClaw over HTTP on the local network.
---

# Add claw-chat Channel

This skill wires NanoClaw's WebChannel to a running claw-chat instance, then registers
the first conversation so the agent is ready to respond.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-claw-chat` is in `applied_skills`, skip to Phase 3
(Configuration). The code changes are already in place.

### Confirm claw-chat is running

Ask the user:

> Is claw-chat already running and accessible? What URL is it at?
> (default: `http://localhost:3000`)

If not running, tell them to start it (`pnpm dev` or `pnpm start` in the claw-chat directory)
before continuing.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-claw-chat
```

This deterministically:
- Adds `src/channels/web.ts` (WebChannel class implementing the Channel interface)
- Adds `src/channels/web.test.ts` (unit tests)
- Three-way merges WebChannel support into `src/index.ts`
- Three-way merges `WEBUI_ONLY` into `src/config.ts`
- No new npm dependencies (uses Node's built-in `fetch`)
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate

```bash
npm test
npm run build
```

All tests (including the new web channel tests) must pass and the build must be clean.

## Phase 3: Configuration

### Generate a shared secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output — this is `INTERNAL_SECRET`.

### Configure NanoClaw

Add to `nanoclaw/.env`:

```env
WEBUI_URL=http://localhost:3000
WEBUI_INTERNAL_SECRET=<secret from above>
WEBUI_POLL_INTERVAL_MS=2000
```

To use claw-chat as the **only** channel (disabling WhatsApp):

```env
WEBUI_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Configure claw-chat

Add to `claw-chat/.env`:

```env
INTERNAL_SECRET=<same secret>
```

Restart claw-chat so it picks up the secret.

## Phase 4: Build and Restart NanoClaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

For Linux:
```bash
systemctl --user restart nanoclaw
```

## Phase 5: Register a Conversation

Open claw-chat in the browser and create a new conversation (e.g., named "Main").

NanoClaw's WebChannel will pick up the registration on its next poll (within 2 seconds)
and register the conversation as a group. Check the logs to confirm:

```bash
tail -f logs/nanoclaw.log | grep -i "web"
```

You should see:
```
WebChannel connected to claw-chat
WebChannel registered conversation { jid: "web:<id>", folder: "web-XXXXXXXX" }
```

## Phase 6: Verify

Send a message in the claw-chat browser UI. The agent should respond within a few seconds.

If the conversation was created before NanoClaw restarted, it will show `registered: false`
in the UI. Refreshing or sending a message will trigger registration on the next poll.

## Troubleshooting

### Agent not responding

1. Check `WEBUI_INTERNAL_SECRET` matches in both `.env` files
2. Verify claw-chat is running: `curl http://localhost:3000/api/health`
3. Check conversation is registered in NanoClaw:
   ```bash
   sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups WHERE jid LIKE 'web:%'"
   ```
4. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### "401 Unauthorized" in logs

`WEBUI_INTERNAL_SECRET` in NanoClaw's `.env` does not match `INTERNAL_SECRET` in claw-chat's `.env`.

### "claw-chat not reachable" in logs

`WEBUI_URL` is wrong, or claw-chat is not running. The WebChannel will keep retrying on every
poll cycle — fix the URL and restart.

### Conversation stuck on "connecting..."

The WebUI shows `registered: false` until NanoClaw acks the registration. If it stays
unregistered after 10 seconds:
1. Check NanoClaw is running and polling: look for WebChannel log lines
2. Check `WEBUI_INTERNAL_SECRET` is correct
3. Try sending a message — this may trigger a fresh registration attempt

### WEBUI_ONLY=true but WhatsApp still connecting

The `.env` change hasn't been synced to `data/env/env`:
```bash
cp .env data/env/env
```
Then restart NanoClaw.

## After Setup

The WebChannel supports:
- **Multiple conversations** — each maps to an isolated NanoClaw group with its own agent memory
- **Typing indicators** — the browser shows a typing animation while the agent works
- **Alongside WhatsApp** — runs as an additional channel by default (omit `WEBUI_ONLY`)
- **VPN access** — claw-chat has no auth, designed for private network access only
