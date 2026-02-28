import { randomUUID } from 'node:crypto';

import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import type { FileEntry } from '../workspace.js';

export interface WebChannelOpts {
  url: string;
  secret: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WebChannel implements Channel {
  name = 'web';
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: WebChannelOpts) {}

  async connect(): Promise<void> {
    this.polling = true;
    this.schedulePoll();
    logger.info({ url: this.opts.url }, 'WebChannel started polling');
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  isConnected(): boolean {
    return this.polling;
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conversationId = jid.slice(4);
    await this.post('/api/internal/deliver', {
      id: randomUUID(),
      conversationId,
      content: text,
      createdAt: new Date().toISOString(),
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const conversationId = jid.slice(4);
    await this.post('/api/internal/typing', { conversationId, isTyping }).catch(err =>
      logger.warn({ jid, err }, 'WebChannel: failed to set typing'),
    );
  }

  async pushContainerStatus(
    jid: string,
    status: 'running' | 'idle' | 'error',
    error?: string,
  ): Promise<void> {
    if (!jid.startsWith('web:')) return;
    const conversationId = jid.slice(4);
    await this.post('/api/internal/container-status', {
      conversationId,
      status,
      ...(error ? { error } : {}),
    }).catch(err => logger.warn({ jid, err }, 'WebChannel: failed to push container status'));
  }

  async pushWorkspaceSnapshot(jid: string, tree: FileEntry[]): Promise<void> {
    if (!jid.startsWith('web:')) return;
    const conversationId = jid.slice(4);
    await this.post('/api/internal/workspace-snapshot', { conversationId, tree }).catch(err =>
      logger.warn({ jid, err }, 'WebChannel: failed to push workspace snapshot'),
    );
  }

  private schedulePoll(): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => void this.poll(), 2000);
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.get<{
        registrations: Array<{ conversationId: string; name: string; folder: string }>;
        messages: Array<{ id: string; conversationId: string; senderName: string; content: string; createdAt: string }>;
      }>('/api/internal/pending');

      const newConversationIds: string[] = [];
      const newMessageIds: string[] = [];

      for (const reg of data.registrations ?? []) {
        const jid = `web:${reg.conversationId}`;
        if (!this.opts.registeredGroups()[jid]) {
          this.opts.onChatMetadata(jid, new Date().toISOString(), reg.name, 'web', false);
          this.opts.registerGroup(jid, {
            name: reg.name,
            folder: reg.folder,
            trigger: '',
            requiresTrigger: false,
            added_at: new Date().toISOString(),
          });
          logger.info({ jid, name: reg.name }, 'WebChannel: registered conversation');
        }
        newConversationIds.push(reg.conversationId);
      }

      for (const msg of data.messages ?? []) {
        const jid = `web:${msg.conversationId}`;
        const newMsg: NewMessage = {
          id: msg.id,
          chat_jid: jid,
          sender: `user@${jid}`,
          sender_name: msg.senderName ?? 'User',
          content: msg.content,
          timestamp: msg.createdAt,
          is_from_me: false,
        };
        this.opts.onMessage(jid, newMsg);
        newMessageIds.push(msg.id);
      }

      if (newConversationIds.length > 0 || newMessageIds.length > 0) {
        await this.post('/api/internal/ack', {
          conversationIds: newConversationIds,
          messageIds: newMessageIds,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'WebChannel: poll error');
    } finally {
      this.schedulePoll();
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.opts.url}${path}`, {
      headers: { Authorization: `Bearer ${this.opts.secret}` },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.opts.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.secret}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  }
}
