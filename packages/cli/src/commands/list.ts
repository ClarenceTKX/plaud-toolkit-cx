import { PlaudConfig, PlaudAuth, PlaudClient, fetchRequester } from '@plaud/core';

function createClient(): PlaudClient {
  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  // Base URL resolves from PLAUD_API_BASE / ~/.plaud/cli.yaml / default.
  return new PlaudClient(auth, config, fetchRequester);
}

export async function listCommand(_args: string[]): Promise<void> {
  const client = createClient();
  const recordings = await client.listRecordings();

  if (recordings.length === 0) {
    console.log('No recordings found.');
    return;
  }

  for (const rec of recordings) {
    const iso = rec.start_at ?? rec.created_at ?? '';
    const date = iso ? iso.slice(0, 16).replace('T', ' ') : '????-??-?? ??:??';
    // duration is milliseconds
    const dur = rec.duration ? `${Math.round(rec.duration / 60000)}m` : '?';
    console.log(`${rec.id}  ${date}  ${dur.padStart(4)}  ${rec.name}`);
  }

  console.log(`\n${recordings.length} recording(s)`);
}
