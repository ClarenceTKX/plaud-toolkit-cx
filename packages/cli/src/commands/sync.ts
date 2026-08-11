import * as fs from 'fs';
import * as path from 'path';
import {
  PlaudConfig,
  PlaudAuth,
  PlaudClient,
  fetchRequester,
  ParakeetBridge,
  recordingStem,
} from '@plaud/core';
import type { PlaudRecordingDetail, PlaudTranscriptSegment } from '@plaud/core';

/**
 * `plaud sync <folder> [--summarize] [--prompt <name>] [--model <id>]`
 *
 * For each new recording: prefer Plaud's server transcript (with speakers);
 * when absent, transcribe locally with macparakeet-cli. Writes the shared-stem
 * set: <stem>.md note, <stem>.json transcript, <stem>.mp3 audio, and
 * <stem>.summary.md ONLY when a summary exists (Plaud's, or one generated via
 * macparakeet + an LLM when --summarize is passed). Never writes empty files.
 */
export async function syncCommand(args: string[]): Promise<void> {
  const positional: string[] = [];
  let summarize = false;
  let promptName = 'Summary';
  let provider = 'cli';
  let command = 'claude -p';
  let model = 'claude-sonnet-5';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--summarize' || a === '--summarise') summarize = true;
    else if (a === '--prompt') promptName = args[++i] ?? promptName;
    else if (a === '--provider') provider = args[++i] ?? provider;
    else if (a === '--command') command = args[++i] ?? command;
    else if (a === '--model') model = args[++i] ?? model;
    else positional.push(a);
  }
  const folder = positional[0];
  if (!folder) {
    console.error('Usage: plaud sync <folder> [--summarize] [--prompt <name>] [--provider <p>] [--command <cmd>] [--model <id>]');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, config, fetchRequester);
  const parakeet = new ParakeetBridge();

  fs.mkdirSync(folder, { recursive: true });

  const recordings = await client.listRecordings();
  console.log(`Found ${recordings.length} recording(s). Checking for new ones...`);

  let synced = 0;
  for (const rec of recordings) {
    const iso = rec.start_at ?? rec.created_at ?? '';
    const date = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'unknown';
    // Shared stem with the Obsidian plugin — identical filenames, no duplicates.
    const stem = recordingStem(rec);
    const mdFile = path.join(folder, `${stem}.md`);

    if (fs.existsSync(mdFile)) continue;

    console.log(`Syncing: ${rec.name} (${rec.id})...`);
    const detail = await client.getRecording(rec.id);

    // Prefer Plaud's server transcript; otherwise transcribe with macparakeet.
    let transcriptText = detail.transcriptText ?? '';
    let segments: PlaudTranscriptSegment[] = detail.segments ?? [];
    let summaryText = detail.summaryText ?? '';
    let transcriptSource: 'plaud' | 'macparakeet' | 'none' = segments.length ? 'plaud' : 'none';

    const audioPath = await downloadAudio(client, detail, folder, stem);

    if (transcriptSource === 'none') {
      if (audioPath) {
        try {
          console.log(`  No Plaud transcript — transcribing with macparakeet…`);
          const result = await parakeet.transcribe(audioPath, { keepHistory: true });
          transcriptText = result.text;
          segments = result.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
          transcriptSource = 'macparakeet';

          if (summarize && result.id) {
            try {
              console.log(`  Summarizing with "${promptName}" (${provider})…`);
              summaryText = await parakeet.summarize(result.id, { promptName, provider, command, model });
            } catch (sumErr: any) {
              console.warn(`  Summary failed: ${sumErr?.message ?? sumErr}`);
            }
          }
        } catch (err: any) {
          console.warn(`  macparakeet failed: ${err?.message ?? err}`);
        }
      } else {
        console.warn(`  No audio available to transcribe.`);
      }
    }

    // ── Note (.md) ──────────────────────────────────────────────────────────
    const noteBody =
      transcriptText.trim().length > 0
        ? transcriptText
        : '*(No transcript available.)*';
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

    // ── Structured transcript (.json) — only when there are segments ────────
    if (segments.length > 0) {
      const payload = { plaud_id: rec.id, name: rec.name, source: transcriptSource, segments };
      fs.writeFileSync(path.join(folder, `${stem}.json`), JSON.stringify(payload, null, 2) + '\n');
    }

    // ── Summary (.summary.md) — only when a summary actually exists ─────────
    if (summaryText && summaryText.trim().length > 0) {
      fs.writeFileSync(path.join(folder, `${stem}.summary.md`), summaryText.trim() + '\n');
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
