import { PlaudConfig, PlaudAuth, PlaudClient, fetchRequester } from '@plaud/core';

function createClient(): PlaudClient {
  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  // Pass config so a region auto-correction persists back to ~/.plaud/config.json.
  return new PlaudClient(auth, creds?.region ?? 'eu', fetchRequester, config);
}

export async function listCommand(_args: string[]): Promise<void> {
  const client = createClient();
  const recordings = await client.listRecordings();

  if (recordings.length === 0) {
    console.log('No recordings found.');
    return;
  }

  for (const rec of recordings) {
    const date = new Date(rec.start_time).toISOString().slice(0, 16).replace('T', ' ');
    const dur = rec.duration ? `${Math.round(rec.duration / 60000)}m` : '?';
    const flags = [rec.is_trans ? 'T' : '', rec.is_summary ? 'S' : ''].filter(Boolean).join('');
    console.log(`${rec.id}  ${date}  ${dur.padStart(4)}  ${flags.padEnd(2)}  ${rec.filename}`);
  }

  console.log(`\n${recordings.length} recording(s)`);
}
