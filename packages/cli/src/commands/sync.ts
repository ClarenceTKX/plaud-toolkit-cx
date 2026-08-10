import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient, fetchRequester } from '@plaud/core';

export async function syncCommand(args: string[]): Promise<void> {
  const folder = args[0];
  if (!folder) {
    console.error('Usage: plaud sync <folder>');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config, fetchRequester);

  fs.mkdirSync(folder, { recursive: true });

  const recordings = await client.listRecordings();
  console.log(`Found ${recordings.length} recording(s). Checking for new ones...`);

  let synced = 0;
  for (const rec of recordings) {
    const iso = rec.start_at ?? rec.created_at ?? '';
    const date = iso ? iso.slice(0, 10) : 'unknown';
    const slug = rec.name?.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50) || rec.id;
    const mdFile = path.join(folder, `${date}_${slug}.md`);

    if (fs.existsSync(mdFile)) continue;

    console.log(`Syncing: ${rec.name} (${rec.id})...`);
    const detail = await client.getRecording(rec.id);

    const content = [
      '---',
      `plaud_id: ${rec.id}`,
      `title: "${rec.name}"`,
      `date: ${date}`,
      `duration: ${Math.round(rec.duration / 60000)}m`,
      `source: plaud`,
      '---',
      '',
      `# ${rec.name}`,
      '',
      detail.transcriptText || '*(No transcript available)*',
    ].join('\n');

    fs.writeFileSync(mdFile, content);
    synced++;
  }

  console.log(synced > 0 ? `Synced ${synced} new recording(s).` : 'Already up to date.');
}
