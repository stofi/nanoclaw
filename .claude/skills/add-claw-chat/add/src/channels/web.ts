import { randomUUID } from 'crypto';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface PendingResponse {
  registrations: Array<{
    conversationId: string;
    name: string;
    folder: string;
    requiresTrigger?: boolean;
  }>;
  messages: Array<{
    id: string;
    conversationId: string;
    senderName: string;
    content: string;
    createdAt: string;
  }>;
}

export class WebChannel implements Channel {
  name = 'web';

  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private secret: string;
  private pollIntervalMs: number;
  private opts: WebChannelOpts;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;

    // Read config from .env (not process.env — keeps URL/secret off environment,
    // matching NanoClaw's pattern of not leaking config to child processes)
    const env = readEnvFile(['WEBUI_URL', 'WEBUI_INTERNAL_SECRET', 'WEBUI_POLL_INTERVAL_MS']);
    this.baseUrl = (
      env.WEBUI_URL ||
      process.env.WEBUI_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
    this.secret = env.WEBUI_INTERNAL_SECRET || process.env.WEBUI_INTERNAL_SECRET || '';
    this.pollIntervalMs = parseInt(
      env.WEBUI_POLL_INTERVAL_MS || process.env.WEBUI_POLL_INTERVAL_MS || '2000',
      10,
    );

    if (!this.secret) {
      throw new Error('WEBUI_INTERNAL_SECRET must be set in .env');
    }
  }

  async connect(): Promise<void> {
    try {
      await this.request('GET', '/api/health');
      logger.info({ url: this.baseUrl }, 'WebChannel connected to claw-chat');
    } catch (err) {
      logger.warn(
        { url: this.baseUrl, err },
        'claw-chat not reachable at startup, will retry on next poll',
      );
    }

    this.connected = true;
    this.schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conversationId = jid.slice(4); // strip "web:"
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    try {
      await this.request('POST', '/api/internal/deliver', {
        id,
        conversationId,
        content: text,
        createdAt,
      });
      logger.info({ jid, length: text.length }, 'WebChannel message delivered');
    } catch (err) {
      logger.warn({ jid, err }, 'WebChannel failed to deliver message to claw-chat');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('WebChannel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const conversationId = jid.slice(4);
    try {
      await this.request('POST', '/api/internal/typing', { conversationId, isTyping });
    } catch {
      // Typing indicators are best-effort; silently ignore network failures
    }
  }

  private schedulePoll(): void {
    if (!this.connected) return;
    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((err) => logger.warn({ err }, 'WebChannel poll error'))
        .finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  /** @internal exposed for testing */
  async poll(): Promise<void> {
    let data: PendingResponse;

    try {
      data = await this.request('GET', '/api/internal/pending');
    } catch (err) {
      logger.warn({ err }, 'WebChannel /pending poll failed, retrying next cycle');
      return;
    }

    const ackedConversationIds: string[] = [];
    const ackedMessageIds: string[] = [];

    // Process registrations before messages so newly registered JIDs are
    // available when we deliver the messages that triggered registration.
    const registeredGroups = this.opts.registeredGroups();
    for (const reg of data.registrations ?? []) {
      const jid = `web:${reg.conversationId}`;
      if (!registeredGroups[jid]) {
        this.opts.registerGroup(jid, {
          name: reg.name,
          folder: reg.folder,
          trigger: reg.folder,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info({ jid, folder: reg.folder }, 'WebChannel registered conversation');
      }
      ackedConversationIds.push(reg.conversationId);
    }

    // Re-fetch after potential registrations above
    const currentGroups = this.opts.registeredGroups();

    for (const msg of data.messages ?? []) {
      const jid = `web:${msg.conversationId}`;
      if (!currentGroups[jid]) {
        logger.warn({ jid }, 'WebChannel: message for unregistered conversation, skipping');
        continue;
      }

      const timestamp = msg.createdAt;
      this.opts.onChatMetadata(jid, timestamp, undefined, 'web', false);
      this.opts.onMessage(jid, {
        id: msg.id,
        chat_jid: jid,
        sender: msg.conversationId,
        sender_name: msg.senderName || 'You',
        content: msg.content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      ackedMessageIds.push(msg.id);
    }

    if (ackedMessageIds.length > 0 || ackedConversationIds.length > 0) {
      try {
        await this.request('POST', '/api/internal/ack', {
          messageIds: ackedMessageIds,
          conversationIds: ackedConversationIds,
        });
      } catch (err) {
        logger.warn({ err }, 'WebChannel ack failed — items may be redelivered on next poll');
      }
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.secret}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      throw new Error(`claw-chat HTTP ${res.status} for ${method} ${path}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
