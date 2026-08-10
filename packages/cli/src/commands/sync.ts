import * as fs from 'fs';
import * as path from 'path';
import {
  PlaudConfig,
  PlaudAuth,
  PlaudClient,
  fetchRequester,
  SuperwhisperBridge,
} from '@plaud/core';
import type { PlaudRecordingDetail, PlaudTranscriptSegment } from '@plaud/core';

export async function syncCommand(args: string[]): Promise<void> {
  const folder = args[0];
  if (!folder) {
    console.error('Usage: plaud sync <folder>');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config, fetchRequester);
  const whisper = new SuperwhisperBridge();

  fs.mkdirSync(folder, { recursive: true });

  const recordings = await client.listRecordings();
  console.log(`Found ${recordings.length} recording(s). Checking for new ones...`);

  let synced = 0;
  for (const rec of recordings) {
    const iso = rec.start_at ?? rec.created_at ?? '';
    const date = iso ? iso.slice(0, 10) : 'unknown';
    const slug = rec.name?.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50) || rec.id;
    const stem = `${date}_${slug}`;
    const mdFile = path.join(folder, `${stem}.md`);

    if (fs.existsSync(mdFile)) continue;

    console.log(`Syncing: ${rec.name} (${rec.id})...`);
    const detail = await client.getRecording(rec.id);

    // Prefer Plaud's server transcript (with speaker labels); otherwise fall
    // back to on-device Superwhisper.
    let transcriptText = detail.transcriptText ?? '';
    let segments: PlaudTranscriptSegment[] = detail.segments ?? [];
    let transcriptSource: 'plaud' | 'superwhisper' | 'none' = segments.length
      ? 'plaud'
      : 'none';

    if (transcriptSource === 'none') {
      const audioPath = await downloadAudio(client, detail, folder, stem);
      if (audioPath) {
        try {
          console.log(`  No Plaud transcript — transcribing with Superwhisper…`);
          const result = await whisper.transcribe(audioPath, {
            onProgress: (ready, expected) =>
              process.stdout.write(`\r  Superwhisper: ${ready}/${expected} done`),
          });
          process.stdout.write('\n');
          transcriptText = result.text;
          segments = result.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
          transcriptSource = 'superwhisper';
        } catch (err: any) {
          console.warn(`  Superwhisper failed: ${err?.message ?? err}`);
        }
      } else {
        console.warn(`  No audio available to transcribe.`);
      }
    }

    // ── Write the note (.md) ────────────────────────────────────────────────
    const noteBody =
      transcriptText.trim().length > 0
        ? transcriptText
        : '*(No transcript available — no Plaud transcript and Superwhisper produced nothing.)*';
    const content = [
      '---',
      `plaud_id: ${rec.id}`,
      `title: "${rec.name}"`,
      `date: ${date}`,
      `duration: ${Math.round(rec.duration / 60000)}m`,
      `source: plaud`,
      `transcript_source: ${transcriptSource}`,
      '---',
      '',
      `# ${rec.name}`,
      '',
      noteBody,
    ].join('\n');
    fs.writeFileSync(mdFile, content);

    // ── Write structured transcript (.json) ─────────────────────────────────
    if (segments.length > 0) {
      const payload = {
        plaud_id: rec.id,
        name: rec.name,
        source: transcriptSource,
        segments,
      };
      fs.writeFileSync(path.join(folder, `${stem}.json`), JSON.stringify(payload, null, 2) + '\n');
    }

    // ── Write Plaud AI summary (.summary.md), when present ───────────────────
    if (detail.summaryText && detail.summaryText.trim().length > 0) {
      fs.writeFileSync(path.join(folder, `${stem}.summary.md`), detail.summaryText.trim() + '\n');
    }

    synced++;
  }

  console.log(synced > 0 ? `Synced ${synced} new recording(s).` : 'Already up to date.');
}

/**
 * Download the recording's audio (Plaud's presigned MP3) into the sync folder
 * as `<stem>.mp3`. Returns the absolute path, or null if unavailable.
 */
async function downloadAudio(
  client: PlaudClient,
  detail: PlaudRecordingDetail,
  folder: string,
  stem: string,
): Promise<string | null> {
  const url = detail.presigned_url ?? (await client.getMp3Url(detail.id));
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const audioPath = path.resolve(folder, `${stem}.mp3`);
    fs.writeFileSync(audioPath, buf);
    return audioPath;
  } catch {
    return null;
  }
}
