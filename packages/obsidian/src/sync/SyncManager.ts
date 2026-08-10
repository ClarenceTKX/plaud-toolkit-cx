import { Notice, normalizePath, TFile, Vault } from 'obsidian';
import { join } from 'path';
import type PlaudPlugin from '../../main';
import type { PlaudFile, PlaudFileDetail, SyncStatus, TranscriptionResult } from '../types';
import {
  triadFolder,
  triadAudioPath,
  triadLlmPath,
} from '../notes/triad';

/**
 * Marker appended to notes whose transcript is voice-only (Superwhisper
 * produced no `llmResult`). The vault-access flow watches for this so it can
 * proactively offer to run AI processing on the recording.
 */
export const AI_PENDING_MARKER =
  '> [!todo] AI processing pending — Superwhisper returned a voice-only transcript (no AI result). Re-run this recording through an AI mode if you want a processed version.';

export class SyncManager {
  private intervalId: number | null = null;
  private isSyncing = false;
  public onStatusChange?: (status: SyncStatus) => void;

  constructor(private plugin: PlaudPlugin) {}

  start(): void {
    const { syncIntervalMinutes } = this.plugin.settings;
    if (syncIntervalMinutes === 0) return;
    this.intervalId = window.setInterval(
      () => this.syncNow(),
      syncIntervalMinutes * 60_000,
    );
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  async syncNow(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync already in progress.');
      return;
    }

    this.isSyncing = true;
    this.setStatus({ state: 'syncing', message: 'Fetching recordings list…' });

    try {
      const remote: PlaudFile[] = await this.plugin.plaudClient.listRecordings();
      const newOnes = remote.filter(
        r => !r.is_trash && !this.plugin.settings.syncedIds.includes(r.id),
      );

      if (newOnes.length === 0) {
        new Notice('Plaud: no new recordings found.');
        this.setStatus({ state: 'idle', message: 'Up to date' });
        return;
      }

      new Notice(`Plaud: syncing ${newOnes.length} new recording(s)…`);

      for (let i = 0; i < newOnes.length; i++) {
        const rec = newOnes[i];
        try {
          await this.syncOne(rec, i + 1, newOnes.length);
        } catch (err: any) {
          console.error(`Plaud: failed to sync recording ${rec.id}`, err);
          new Notice(`Plaud: error syncing "${rec.filename ?? rec.id}": ${err.message}`);
        }
      }

      new Notice(`Plaud: sync complete. ${newOnes.length} note(s) created.`);
      this.setStatus({ state: 'idle', message: `Last sync: ${new Date().toLocaleTimeString()}` });
    } catch (err: any) {
      console.error('Plaud: sync failed', err);
      new Notice(`Plaud sync error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncOne(rec: PlaudFile, index: number, total: number): Promise<void> {
    const label = rec.filename ?? rec.id;

    // ── Download audio ────────────────────────────────────────────────────
    this.setStatus({
      state: 'downloading',
      message: `(${index}/${total}) Downloading "${label}"…`,
      recordingId: rec.id,
    });

    // Triad model: all three artifacts share one folder + timestamp stem
    // (derived internally by the triad path helpers from `rec`).
    const folder = triadFolder(this.plugin.settings);
    await this.ensureVaultFolder(folder);

    const ext = rec.fullname?.split('.').pop() ?? 'opus';
    const audioVaultPath = normalizePath(triadAudioPath(rec, this.plugin.settings, ext));

    if (!this.plugin.app.vault.getAbstractFileByPath(audioVaultPath)) {
      const buffer = await this.plugin.plaudClient.downloadAudioBuffer(rec.id);
      await this.plugin.app.vault.createBinary(audioVaultPath, buffer);
    }

    // ── Fetch MP3 (always try when original is .opus) ─────────────────────
    let bestAudioPath = audioVaultPath;

    if (ext === 'opus') {
      const mp3VaultPath = normalizePath(triadAudioPath(rec, this.plugin.settings, 'mp3'));

      if (this.plugin.app.vault.getAbstractFileByPath(mp3VaultPath)) {
        bestAudioPath = mp3VaultPath;
      } else {
        this.setStatus({
          state: 'downloading',
          message: `(${index}/${total}) Fetching MP3 for "${label}"…`,
          recordingId: rec.id,
        });

        try {
          const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(rec.id);
          if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
            const mp3Buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
            await this.plugin.app.vault.createBinary(mp3VaultPath, mp3Buffer);
            bestAudioPath = mp3VaultPath;
          } else {
            const buffer = await this.plugin.plaudClient.downloadAudioBuffer(rec.id);
            const header = new Uint8Array(buffer.slice(0, 3));
            const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                       || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
            if (isMP3) {
              await this.plugin.app.vault.createBinary(mp3VaultPath, buffer);
              bestAudioPath = mp3VaultPath;
            }
          }
        } catch (dlErr: any) {
          console.warn(`Plaud: MP3 download failed for ${rec.id}`, dlErr);
        }
      }
    }

    // ── Transcribe ────────────────────────────────────────────────────────
    this.setStatus({
      state: 'transcribing',
      message: `(${index}/${total}) Transcribing "${label}"…`,
      recordingId: rec.id,
    });

    const detail: PlaudFileDetail = await this.plugin.plaudClient.getRecordingDetail(rec.id);

    let transcription: TranscriptionResult;

    if (hasRealTranscript(detail.transcriptText)) {
      transcription = parseServerTranscript(detail.transcriptText!);
    } else if (bestAudioPath.endsWith('.opus')) {
      // Still only have the encrypted .opus — can't transcribe
      transcription = {
        text: '*(No MP3 version available yet — open this recording in the Plaud app to process it, then re-sync.)*',
        segments: [],
      };
    } else {
      try {
        const vaultBasePath = (this.plugin.app.vault.adapter as any).getBasePath?.() ?? '';
        const audioAbsPath = join(vaultBasePath, bestAudioPath);
        transcription = await this.plugin.whisperBridge.transcribe(
          audioAbsPath,
          this.plugin.settings,
        );
      } catch (whisperErr: any) {
        console.warn(`Plaud: Superwhisper failed for ${rec.id}, creating note without transcript.`, whisperErr);
        transcription = { text: '*(Superwhisper transcription failed — check the Superwhisper app and recordings folder in settings.)*', segments: [] };
      }
    }

    // ── Create note ───────────────────────────────────────────────────────
    const notePath = await this.plugin.noteFactory.createNote(
      rec,
      detail,
      transcription,
      bestAudioPath,
      this.plugin.settings,
    );

    // ── Write the AI-result file (only when Superwhisper produced one) ─────
    // Voice-only results omit `<ts>.llm.md` entirely; the note still carries the
    // AI-pending flag below so the vault CLAUDE.md flow can offer to process it.
    await writeLlmSidecar(
      this.plugin.app.vault,
      triadLlmPath(rec, this.plugin.settings),
      transcription,
    );

    // Flag voice-only Superwhisper results so the vault-access flow can
    // proactively offer to run AI processing (no llmResult was present).
    await annotateAiPending(this.plugin.app.vault, notePath, transcription);

    // Note: no context-based rename — triad files are keyed by a stable
    // timestamp stem (`<ts>.md/.llm.md/.<ext>`) so the three stay grouped.

    // Persist dedup
    this.plugin.settings.syncedIds.push(rec.id);
    await this.plugin.saveSettings();

    this.plugin.refreshRecordingsView();
  }

  /**
   * Remove a recording: delete note + audio files, remove from syncedIds.
   * Optionally trash on Plaud servers.
   */
  async removeRecording(id: string, alsoRemote: boolean): Promise<void> {
    const vault = this.plugin.app.vault;
    const folder = triadFolder(this.plugin.settings);

    // Locate the note by scanning frontmatter for plaud_id, then delete the
    // whole triad (note + audio + optional .llm.md) which shares the note's
    // timestamp stem in the triad folder.
    const noteFiles = vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder + '/'),
    );
    let stem: string | null = null;
    for (const file of noteFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.plaud_id === id) {
        stem = file.basename.replace(/\.llm$/, ''); // note basename is the stem
        await vault.trash(file, true);
        break;
      }
    }

    // Delete all sibling triad files sharing the stem (audio + .llm.md).
    if (stem) {
      const siblings = vault.getFiles().filter(f =>
        f.path.startsWith(folder + '/') &&
        (f.basename === stem || f.basename === `${stem}.llm`),
      );
      for (const file of siblings) {
        await vault.trash(file, true);
      }
    }

    // Remove from syncedIds
    const idx = this.plugin.settings.syncedIds.indexOf(id);
    if (idx !== -1) {
      this.plugin.settings.syncedIds.splice(idx, 1);
      await this.plugin.saveSettings();
    }

    // Optionally trash on Plaud servers
    if (alsoRemote) {
      const ok = await this.plugin.plaudClient.trashRecording(id);
      if (!ok) {
        new Notice('Plaud: failed to trash recording on server — removed locally only.');
      }
    }

    this.plugin.refreshRecordingsView();
  }

  /**
   * Remove all synced recordings. Optionally trash on Plaud servers.
   */
  async removeAllRecordings(alsoRemote: boolean): Promise<void> {
    const ids = [...this.plugin.settings.syncedIds];
    for (const id of ids) {
      await this.removeRecording(id, alsoRemote);
    }
    new Notice(`Plaud: removed ${ids.length} recording(s).`);
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
        try { await this.plugin.app.vault.createFolder(current); } catch (_) {}
      }
    }
  }

  /**
   * Re-transcribe a single note by its plaud_id.
   * Fetches a fresh transcript (server or Whisper) and replaces the note content.
   */
  async retranscribeOne(plaudId: string): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync in progress — try again after it finishes.');
      return;
    }

    const vault = this.plugin.app.vault;
    const folder = triadFolder(this.plugin.settings);

    // Find the note file in the triad folder by plaud_id frontmatter.
    const noteFiles = vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder + '/'),
    );
    let file: TFile | undefined;
    for (const f of noteFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.plaud_id === plaudId) { file = f; break; }
    }
    if (!file) {
      new Notice('Plaud: note not found for this recording.');
      return;
    }

    // The audio shares the note's timestamp stem in the triad folder.
    const stem = file.basename;

    this.isSyncing = true;
    this.setStatus({ state: 'transcribing', message: `Re-transcribing "${file.basename}"…` });

    try {
      const detail = await this.plugin.plaudClient.getRecordingDetail(plaudId);
      let transcription: TranscriptionResult | null = null;

      if (hasRealTranscript(detail.transcriptText)) {
        transcription = parseServerTranscript(detail.transcriptText!);
      } else {
        // Reuse the triad's audio if present, else download it into the triad.
        let mp3Path: string | null = null;

        const existingAudio = vault.getFiles().find(
          f => f.path.startsWith(folder + '/') &&
               f.basename === stem &&
               f.extension !== 'md',
        );

        if (existingAudio) {
          mp3Path = existingAudio.path;
        } else {
          this.setStatus({ state: 'downloading', message: `Fetching MP3 for "${file.basename}"…` });
          await this.ensureVaultFolder(folder);
          const mp3VaultPath = normalizePath(`${folder}/${stem}.mp3`);

          try {
            const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(plaudId);
            if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
              const buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
              await vault.createBinary(mp3VaultPath, buffer);
              mp3Path = mp3VaultPath;
            } else {
              const buffer = await this.plugin.plaudClient.downloadAudioBuffer(plaudId);
              const header = new Uint8Array(buffer.slice(0, 3));
              const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                         || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
              if (isMP3) {
                await vault.createBinary(mp3VaultPath, buffer);
                mp3Path = mp3VaultPath;
              }
            }
          } catch (dlErr: any) {
            console.warn(`Plaud: MP3 download failed for ${plaudId}`, dlErr);
          }
        }

        if (mp3Path) {
          this.setStatus({ state: 'transcribing', message: `Transcribing "${file.basename}"…` });
          const vaultBasePath = (vault.adapter as any).getBasePath?.() ?? '';
          const absPath = join(vaultBasePath, mp3Path);
          transcription = await this.plugin.whisperBridge.transcribe(absPath, this.plugin.settings);
        }
      }

      if (transcription && transcription.text.trim().length > 0) {
        const oldContent = await vault.read(file);
        const timestamps = transcription.segments
          .map(s => `- **${fmtTs(s.start)}** — ${s.text}`)
          .join('\n');

        let newContent = oldContent;

        // Replace existing transcript section
        newContent = newContent.replace(
          /(## Transcript\n\n)([\s\S]*?)((?=\n## )|$)/,
          `$1${transcription.text}\n\n`,
        );

        // Replace timestamps section
        if (timestamps) {
          newContent = newContent.replace(
            /(## Timestamps\n\n)([\s\S]*?)$/,
            `$1${timestamps}\n`,
          );
        }

        await vault.modify(file, newContent);
        await writeLlmSidecar(
          vault,
          normalizePath(`${folder}/${stem}.llm.md`),
          transcription,
        );
        await annotateAiPending(vault, file.path, transcription);
        new Notice(`Plaud: re-transcribed "${file.basename}".`);
      } else {
        new Notice('Plaud: no transcript available yet for this recording.');
      }

      this.setStatus({ state: 'idle', message: `Re-transcribed: ${new Date().toLocaleTimeString()}` });
      this.plugin.refreshRecordingsView();
    } catch (err: any) {
      console.error(`Plaud: retranscribe failed for ${plaudId}`, err);
      new Notice(`Plaud: re-transcribe error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Scan notes with pending transcription placeholders, try to fetch MP3
   * from Plaud API, and transcribe locally with Whisper.
   */
  async retranscribePending(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync in progress — try again after it finishes.');
      return;
    }

    this.isSyncing = true;
    this.setStatus({ state: 'syncing', message: 'Scanning for pending transcriptions…' });

    const PENDING_MARKERS = [
      'Awaiting Plaud server transcription',
      'No MP3 version available yet',
      'No transcript available',
      'Whisper transcription failed',
      'Superwhisper transcription failed',
    ];

    try {
      await this.plugin.authManager.ensureToken();
      const folder = triadFolder(this.plugin.settings);
      const vault = this.plugin.app.vault;

      // `.llm.md` sidecars are also `.md`; exclude them so we only scan notes.
      const noteFiles = vault.getFiles().filter(
        f => f.path.startsWith(folder) && f.extension === 'md' && !f.name.endsWith('.llm.md'),
      );

      const pending: { file: TFile; plaudId: string }[] = [];
      for (const file of noteFiles) {
        const content = await vault.cachedRead(file);
        if (!PENDING_MARKERS.some(m => content.includes(m))) continue;
        const idMatch = content.match(/plaud_id:\s*(\S+)/);
        if (idMatch) pending.push({ file, plaudId: idMatch[1] });
      }

      if (pending.length === 0) {
        new Notice('Plaud: no pending transcriptions found.');
        this.setStatus({ state: 'idle', message: 'No pending transcriptions' });
        return;
      }

      new Notice(`Plaud: retranscribing ${pending.length} recording(s)…`);
      let transcribed = 0;
      let skipped = 0;

      for (let i = 0; i < pending.length; i++) {
        const { file, plaudId } = pending[i];

        try {
          // First check if Plaud now has a server transcript
          this.setStatus({
            state: 'transcribing',
            message: `(${i + 1}/${pending.length}) Checking "${file.basename}"…`,
          });

          const detail = await this.plugin.plaudClient.getRecordingDetail(plaudId);
          let transcription: TranscriptionResult | null = null;

          if (hasRealTranscript(detail.transcriptText)) {
            transcription = parseServerTranscript(detail.transcriptText!);
          } else {
            // Reuse the triad audio (shares the note's stem) or download it.
            let mp3Path: string | null = null;
            const stem = file.basename;

            const existingAudio = vault.getFiles().find(
              f => f.path.startsWith(folder + '/') &&
                   f.basename === stem &&
                   f.extension !== 'md',
            );

            if (existingAudio) {
              mp3Path = existingAudio.path;
            } else {
              // Try downloading MP3 from API into the triad folder.
              this.setStatus({
                state: 'downloading',
                message: `(${i + 1}/${pending.length}) Fetching MP3 for "${file.basename}"…`,
              });

              await this.ensureVaultFolder(folder);
              const mp3VaultPath = normalizePath(`${folder}/${stem}.mp3`);

              try {
                const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(plaudId);
                if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
                  const buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
                  await vault.createBinary(mp3VaultPath, buffer);
                  mp3Path = mp3VaultPath;
                } else {
                  const buffer = await this.plugin.plaudClient.downloadAudioBuffer(plaudId);
                  const header = new Uint8Array(buffer.slice(0, 3));
                  const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                             || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
                  if (isMP3) {
                    await vault.createBinary(mp3VaultPath, buffer);
                    mp3Path = mp3VaultPath;
                  }
                }
              } catch (dlErr: any) {
                console.warn(`Plaud: MP3 download failed for ${plaudId}`, dlErr);
              }
            }

            if (mp3Path) {
              this.setStatus({
                state: 'transcribing',
                message: `(${i + 1}/${pending.length}) Transcribing "${file.basename}"…`,
              });
              const vaultBasePath = (vault.adapter as any).getBasePath?.() ?? '';
              const absPath = join(vaultBasePath, mp3Path);
              transcription = await this.plugin.whisperBridge.transcribe(absPath, this.plugin.settings);
            }
          }

          if (transcription && transcription.text.trim().length > 0) {
            const oldContent = await vault.read(file);
            const timestamps = transcription.segments
              .map(s => `- **${fmtTs(s.start)}** — ${s.text}`)
              .join('\n');

            let newContent = oldContent;
            for (const marker of PENDING_MARKERS) {
              // Match *(marker text…)* — use [\s\S]*? to handle ) inside the text
              newContent = newContent.replace(
                new RegExp(`\\*\\(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\)\\*`),
                transcription.text,
              );
            }
            // Update timestamps section
            newContent = newContent.replace(
              /## Timestamps\n\n\s*$/,
              `## Timestamps\n\n${timestamps}\n`,
            );

            await vault.modify(file, newContent);
            await writeLlmSidecar(
              vault,
              normalizePath(`${folder}/${file.basename}.llm.md`),
              transcription,
            );
            await annotateAiPending(vault, file.path, transcription);
            transcribed++;
          } else {
            skipped++;
          }
        } catch (err: any) {
          console.error(`Plaud: retranscribe failed for ${plaudId}`, err);
          new Notice(`Plaud: error for "${file.basename}": ${err.message}`);
          skipped++;
        }
      }

      const msg = transcribed > 0
        ? `Transcribed ${transcribed} recording(s).` + (skipped > 0 ? ` ${skipped} still pending.` : '')
        : 'No recordings could be transcribed yet — MP3 versions may not be ready on Plaud servers.';
      new Notice(`Plaud: ${msg}`);
      this.setStatus({ state: 'idle', message: `Last retranscribe: ${new Date().toLocaleTimeString()}` });
      this.plugin.refreshRecordingsView();
    } catch (err: any) {
      console.error('Plaud: retranscribe failed', err);
      new Notice(`Plaud retranscribe error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  private setStatus(status: SyncStatus): void {
    this.onStatusChange?.(status);
  }
}

/**
 * Parse Plaud's server-generated transcript (markdown with [Speaker N] labels)
 * into a TranscriptionResult. No timestamps available from the server transcript.
 */
function parseServerTranscript(raw: string): TranscriptionResult {
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const segments: { start: number; end: number; text: string }[] = [];
  let offset = 0;

  for (const line of lines) {
    // Skip markdown headings like "## Transcripció literal"
    if (line.startsWith('#')) continue;
    const text = line.replace(/^\[Speaker \d+\]\s*/, '').trim();
    if (!text) continue;
    segments.push({ start: offset, end: offset + 1, text });
    offset += 1;
  }

  const fullText = segments.map(s => s.text).join('\n\n');
  return { text: fullText, segments };
}

/**
 * Write the triad's `<ts>.llm.md` sidecar — but only when Superwhisper actually
 * produced an AI result. Voice-only recordings omit the file entirely (per the
 * triad spec); the note's AI-pending flag is what signals "not yet processed".
 *
 * When `llmProcessed` is true the transcription's `text` already holds the
 * `llmResult` (the bridge prefers it), so we persist that here.
 */
async function writeLlmSidecar(
  vault: Vault,
  llmPath: string,
  transcription: TranscriptionResult,
): Promise<void> {
  const llmProcessed = (transcription as { llmProcessed?: boolean }).llmProcessed;
  if (llmProcessed !== true) return; // omit file for voice-only results

  const text = transcription.text?.trim() ?? '';
  if (!text || text.startsWith('*(')) return;

  const normalized = normalizePath(llmPath);
  const existing = vault.getAbstractFileByPath(normalized);
  const body = `${text}\n`;
  if (existing instanceof TFile) {
    await vault.modify(existing, body);
  } else {
    await vault.create(normalized, body);
  }
}

/**
 * If a transcription came back voice-only (Superwhisper produced no LLM result),
 * mark its note so the vault-access flow can offer to run AI processing.
 *
 * Adds `superwhisper_ai_processed: false` to frontmatter and appends a callout
 * marker. Real transcripts (with an AI result) and placeholder notes are left
 * untouched.
 */
async function annotateAiPending(
  vault: Vault,
  notePath: string,
  transcription: TranscriptionResult,
): Promise<void> {
  // `llmProcessed` only exists on Superwhisper results; server/placeholder
  // transcripts don't carry it, so this narrows to genuine voice-only cases.
  const llmProcessed = (transcription as { llmProcessed?: boolean }).llmProcessed;
  if (llmProcessed !== false) return;

  // Skip placeholder/error transcripts — nothing to AI-process.
  const text = transcription.text?.trim() ?? '';
  if (!text || text.startsWith('*(')) return;

  const file = vault.getAbstractFileByPath(notePath);
  if (!(file instanceof TFile)) return;

  let content = await vault.read(file);
  if (content.includes(AI_PENDING_MARKER)) return; // idempotent

  // Insert a frontmatter flag if the note has frontmatter.
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end !== -1 && !/\nsuperwhisper_ai_processed:/.test(content.slice(0, end))) {
      content =
        content.slice(0, end) +
        '\nsuperwhisper_ai_processed: false' +
        content.slice(end);
    }
  }

  // Append the human-readable marker at the end.
  content = content.replace(/\s*$/, '\n\n') + AI_PENDING_MARKER + '\n';

  await vault.modify(file, content);
}

function fmtTs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * A Plaud `transcript` field is only usable if it's non-trivial AND not a raw
 * data payload (e.g. the "marks" JSON returned before the real transcript is
 * ready). Otherwise the recording should be treated as not-yet-transcribed.
 */
function hasRealTranscript(transcript: string | undefined | null): boolean {
  return !!transcript && transcript.length > 20 && !looksLikeJson(transcript);
}

/** Heuristic: does this text look like a serialized JSON object/array? */
function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    // Even if it doesn't parse cleanly, bail on obvious marks-data payloads.
    return /"?mark_type"?|"?mark_content"?|"?timestamp"?/.test(t);
  }
}
