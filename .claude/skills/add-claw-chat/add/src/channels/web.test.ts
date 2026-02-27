import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted before imports) ---

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    WEBUI_URL: 'http://localhost:3000',
    WEBUI_INTERNAL_SECRET: 'test-secret-abc',
    WEBUI_POLL_INTERVAL_MS: '50',
  }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Imports ---

import { WebChannel, WebChannelOpts } from './web.js';

// --- Helpers ---

function makeFetchMock(responses: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = new URL(url).pathname;
    const entry = responses[path] ?? { status: 200, body: null };
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => (entry.body != null ? JSON.stringify(entry.body) : ''),
    };
  });
}

function makeOpts(overrides?: Partial<WebChannelOpts>): WebChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

// --- Tests ---

describe('WebChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock({
      '/api/health': { status: 200, body: { ok: true } },
      '/api/internal/pending': { status: 200, body: { registrations: [], messages: [] } },
      '/api/internal/deliver': { status: 201 },
      '/api/internal/ack': { status: 204 },
      '/api/internal/typing': { status: 204 },
    });
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for web: JIDs', () => {
      const ch = new WebChannel(makeOpts());
      expect(ch.ownsJid('web:550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('returns false for non-web JIDs', () => {
      const ch = new WebChannel(makeOpts());
      expect(ch.ownsJid('slack:C123456')).toBe(false);
      expect(ch.ownsJid('1234567890@g.us')).toBe(false);
      expect(ch.ownsJid('tg:12345')).toBe(false);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('POSTs to /api/internal/deliver with correct payload', async () => {
      const ch = new WebChannel(makeOpts());
      await ch.sendMessage('web:conv-123', 'Hello from agent');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/internal/deliver',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret-abc',
          }),
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.conversationId).toBe('conv-123');
      expect(body.content).toBe('Hello from agent');
      expect(body.id).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
    });

    it('strips the web: prefix before sending conversationId', async () => {
      const ch = new WebChannel(makeOpts());
      await ch.sendMessage('web:abc-123', 'test');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.conversationId).toBe('abc-123');
    });

    it('does not throw on HTTP error — logs warning instead', async () => {
      fetchMock = makeFetchMock({ '/api/internal/deliver': { status: 500 } });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(makeOpts());
      await expect(ch.sendMessage('web:conv-123', 'hello')).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('POSTs to /api/internal/typing', async () => {
      const ch = new WebChannel(makeOpts());
      await ch.setTyping('web:conv-123', true);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/internal/typing',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ conversationId: 'conv-123', isTyping: true });
    });

    it('does not throw on HTTP error', async () => {
      fetchMock = makeFetchMock({ '/api/internal/typing': { status: 500 } });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(makeOpts());
      await expect(ch.setTyping('web:conv-123', false)).resolves.toBeUndefined();
    });
  });

  // --- poll ---

  describe('poll', () => {
    it('calls registerGroup for unregistered conversations', async () => {
      const opts = makeOpts();
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: {
            registrations: [
              { conversationId: 'conv-abc', name: 'Main', folder: 'web-conv-abc', requiresTrigger: false },
            ],
            messages: [],
          },
        },
        '/api/internal/ack': { status: 204 },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      expect(opts.registerGroup).toHaveBeenCalledWith('web:conv-abc', {
        name: 'Main',
        folder: 'web-conv-abc',
        trigger: 'web-conv-abc',
        added_at: expect.any(String),
        requiresTrigger: false,
      });
    });

    it('does not re-register already registered conversations', async () => {
      const opts = makeOpts({
        registeredGroups: vi.fn().mockReturnValue({ 'web:conv-abc': { name: 'Main' } }),
      });
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: {
            registrations: [{ conversationId: 'conv-abc', name: 'Main', folder: 'web-conv-abc' }],
            messages: [],
          },
        },
        '/api/internal/ack': { status: 204 },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      expect(opts.registerGroup).not.toHaveBeenCalled();
    });

    it('calls onMessage and onChatMetadata for messages in registered conversations', async () => {
      const jid = 'web:conv-abc';
      const opts = makeOpts({
        registeredGroups: vi.fn().mockReturnValue({ [jid]: { name: 'Main' } }),
      });
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: {
            registrations: [],
            messages: [
              {
                id: 'msg-1',
                conversationId: 'conv-abc',
                senderName: 'You',
                content: 'Hello agent',
                createdAt: '2026-02-27T10:00:00.000Z',
              },
            ],
          },
        },
        '/api/internal/ack': { status: 204 },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        jid,
        '2026-02-27T10:00:00.000Z',
        undefined,
        'web',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(jid, {
        id: 'msg-1',
        chat_jid: jid,
        sender: 'conv-abc',
        sender_name: 'You',
        content: 'Hello agent',
        timestamp: '2026-02-27T10:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      });
    });

    it('skips messages for unregistered conversations', async () => {
      const opts = makeOpts({
        registeredGroups: vi.fn().mockReturnValue({}),
      });
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: {
            registrations: [],
            messages: [
              {
                id: 'msg-1',
                conversationId: 'unknown-conv',
                senderName: 'You',
                content: 'Hello',
                createdAt: '2026-02-27T10:00:00.000Z',
              },
            ],
          },
        },
        '/api/internal/ack': { status: 204 },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('calls /ack with processed message and conversation IDs', async () => {
      const jid = 'web:conv-abc';
      const opts = makeOpts({
        registeredGroups: vi.fn().mockReturnValue({ [jid]: { name: 'Main' } }),
      });
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: {
            registrations: [{ conversationId: 'reg-1', name: 'Other', folder: 'web-reg-1' }],
            messages: [
              {
                id: 'msg-1',
                conversationId: 'conv-abc',
                senderName: 'You',
                content: 'Hi',
                createdAt: '2026-02-27T10:00:00.000Z',
              },
            ],
          },
        },
        '/api/internal/ack': { status: 204 },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      const ackCall = fetchMock.mock.calls.find(
        (c: any[]) => (c[0] as string).includes('/api/internal/ack'),
      );
      expect(ackCall).toBeTruthy();
      const ackBody = JSON.parse(ackCall![1].body);
      expect(ackBody.messageIds).toContain('msg-1');
      expect(ackBody.conversationIds).toContain('reg-1');
    });

    it('does not call /ack when nothing was processed', async () => {
      const opts = makeOpts();
      fetchMock = makeFetchMock({
        '/api/internal/pending': {
          status: 200,
          body: { registrations: [], messages: [] },
        },
      });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await ch.poll();

      const ackCall = fetchMock.mock.calls.find(
        (c: any[]) => (c[0] as string).includes('/api/internal/ack'),
      );
      expect(ackCall).toBeUndefined();
    });

    it('does not throw when /pending returns HTTP error', async () => {
      const opts = makeOpts();
      fetchMock = makeFetchMock({ '/api/internal/pending': { status: 503 } });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(opts);
      await expect(ch.poll()).resolves.toBeUndefined();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- connect / disconnect ---

  describe('connect', () => {
    it('sets connected=true even if health check fails', async () => {
      fetchMock = makeFetchMock({ '/api/health': { status: 503 } });
      global.fetch = fetchMock as any;

      const ch = new WebChannel(makeOpts());
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
      await ch.disconnect();
    });
  });

  describe('disconnect', () => {
    it('sets connected=false and stops polling', async () => {
      const ch = new WebChannel(makeOpts());
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });
});
