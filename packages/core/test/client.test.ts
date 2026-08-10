import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudClient } from '../src/client.js';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE = 'https://platform.plaud.ai/developer/api';

describe('PlaudClient (platform API)', () => {
  let tmpDir: string;
  let client: PlaudClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-client-'));
    const config = new PlaudConfig(tmpDir);
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(
      JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    config.saveToken({
      accessToken: token,
      tokenType: 'bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });
    const auth = new PlaudAuth(config);
    client = new PlaudClient(auth, config); // base URL resolved from config
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists recordings and normalizes fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: 'list',
        page: 1,
        page_size: 20,
        data: [
          {
            id: '8f2b',
            name: 'Working Session',
            created_at: '2026-08-07T02:15:25',
            start_at: '2026-08-07T00:56:45.565000',
            duration: 4565000,
            serial_number: 'SN1',
          },
        ],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('8f2b');
    expect(recs[0].name).toBe('Working Session');
    expect(recs[0].duration).toBe(4565000); // milliseconds
    // legacy alias populated
    expect(recs[0].filename).toBe('Working Session');
    expect(recs[0].start_time).toBe(Date.parse('2026-08-07T00:56:45.565000'));
  });

  it('clamps page_size to the API minimum of 10', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await client.listRecordings(1, 2);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('page_size=10');
    expect(url).toContain(`${BASE}/open/third-party/files/`);
  });

  it('builds transcript from source_list transaction segments', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'rec1',
        name: 'Meeting',
        duration: 1000,
        presigned_url: 'https://s3.example/rec1.mp3?sig',
        note_list: [
          { data_type: 'auto_sum_note', data_content: '# Summary\nKey points…' },
        ],
        source_list: [
          {
            data_type: 'transaction',
            data_content: JSON.stringify([
              { start_time: 0, end_time: 2000, content: 'Hello everyone.' },
              { start_time: 2000, end_time: 4000, content: 'Welcome to the meeting.' },
            ]),
          },
        ],
      }),
    });

    const detail = await client.getRecording('rec1');
    // no speaker labels → one segment per line
    expect(detail.transcriptText).toBe('Hello everyone.\nWelcome to the meeting.');
    expect(detail.summaryText).toContain('Key points');
    expect(detail.presigned_url).toContain('rec1.mp3');
    expect(detail.audio).toBe(true);
    expect(detail.transcript).toBe(true); // availability flag
  });

  it('extracts speaker-labelled segments and speaker-prefixed text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'rec2',
        name: 'Meeting',
        duration: 1000,
        source_list: [
          {
            data_type: 'transaction',
            data_content: JSON.stringify([
              { start_time: 4550, end_time: 45420, content: 'Welcome everyone.', speaker: 'Caleb', original_speaker: 'Speaker 1' },
              { start_time: 45420, end_time: 60000, content: 'Thanks for having me.', speaker: 'Ryan', original_speaker: 'Speaker 2' },
              { start_time: 60000, end_time: 65000, content: 'Let us begin.', speaker: 'Caleb', original_speaker: 'Speaker 1' },
            ]),
          },
        ],
      }),
    });

    const detail = await client.getRecording('rec2');
    // structured segments carry speaker + original_speaker, times in seconds
    expect(detail.segments).toHaveLength(3);
    expect(detail.segments![0]).toMatchObject({
      start: 4.55,
      end: 45.42,
      text: 'Welcome everyone.',
      speaker: 'Caleb',
      original_speaker: 'Speaker 1',
    });
    // flat text is speaker-prefixed on speaker change
    expect(detail.transcriptText).toBe(
      'Caleb: Welcome everyone.\nRyan: Thanks for having me.\nCaleb: Let us begin.',
    );
  });

  it('gets user info from /users/current', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'u1', nickname: 'KT', email: 'kt@plaud.ai' }),
    });

    const user = await client.getUserInfo();
    expect(user.id).toBe('u1');
    expect(user.nickname).toBe('KT');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/open/third-party/users/current');
  });

  it('returns the presigned URL as the MP3 URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'rec1', name: 'X', duration: 0, presigned_url: 'https://s3/rec1.mp3?x' }),
    });
    const url = await client.getMp3Url('rec1');
    expect(url).toBe('https://s3/rec1.mp3?x');
  });

  it('surfaces API error detail on non-2xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ msg: 'page_size too small' }] }),
    });
    await expect(client.listRecordings()).rejects.toThrow(/422/);
  });

  it('sends a non-default User-Agent header', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await client.listRecordings();
    const [, init] = mockFetch.mock.calls[0];
    const ua = new Headers(init.headers).get('User-Agent');
    expect(ua).toBeTruthy();
    expect(ua).not.toBe('node');
  });

  it('uses an injected requester instead of global fetch', async () => {
    const calls: string[] = [];
    const requester = vi.fn(async (req: { url: string }) => {
      calls.push(req.url);
      return { status: 200, ok: true, json: async () => ({ data: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    });
    const config = new PlaudConfig(tmpDir);
    const auth = new PlaudAuth(config, requester);
    const injected = new PlaudClient(auth, config, requester);

    await injected.listRecordings();

    expect(requester).toHaveBeenCalled();
    expect(calls[0]).toContain('/open/third-party/files/');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
