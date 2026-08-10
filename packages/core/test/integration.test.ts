import { describe, it, expect } from 'vitest';
import { PlaudConfig, PlaudAuth, PlaudClient } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Authenticated if either the passkey tokens.json or legacy config.json exists.
const HAS_AUTH =
  fs.existsSync(path.join(os.homedir(), '.plaud', 'tokens.json')) ||
  fs.existsSync(path.join(os.homedir(), '.plaud', 'config.json'));

describe.skipIf(!HAS_AUTH)('integration (live API)', () => {
  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config);

  it('gets user info', async () => {
    const user = await client.getUserInfo();
    expect(user.id).toBeTruthy();
    expect(user.nickname).toBeTruthy();
  });

  it('lists recordings', async () => {
    const recs = await client.listRecordings();
    expect(Array.isArray(recs)).toBe(true);
  });

  it('gets recording detail', async () => {
    const recs = await client.listRecordings();
    if (recs.length === 0) return;
    const detail = await client.getRecording(recs[0].id);
    expect(detail.id).toBe(recs[0].id);
  });
});
