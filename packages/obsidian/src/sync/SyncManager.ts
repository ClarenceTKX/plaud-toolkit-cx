import { Notice, normalizePath, TFile, Vault } from 'obsidian';
import { join } from 'path';
import type PlaudPlugin from '../../main';
import type { PlaudFile, PlaudFileDetail, SyncStatus, TranscriptionResult } from '../types';
import {
  triadFolder,
  triadAudioPath,
  triadTranscriptJsonPath,
  triadSummaryPath,
} from '../notes/triad';

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

    // Triad model: all artifacts share one folder + stem (derived by the triad
    // path helpers from `rec`). The platform API serves a single MP3 per
    // recording via a presigned URL, so we download exactly one audio file.
    const folder = triadFolder(this.plugin.settings);
    await this.ensureVaultFolder(folder);

    const mp3VaultPath = normalizePath(triadAudioPath(rec, this.plugin.settings, 'mp3'));
    let bestAudioPath = mp3VaultPath;

    if (!this.plugin.app.vault.getAbstractFileByPath(mp3VaultPath)) {
      this.setStatus({
        state: 'downloading',
        message: `(${index}/${total}) Downloading audio for "${label}"…`,
        recordingId: rec.id,
      });
      try {
        const buffer = await this.plugin.plaudClient.downloadAudioBuffer(rec.id);
        await this.plugin.app.vault.createBinary(mp3VaultPath, buffer);
      } catch (dlErr: any) {
        console.warn(`Plaud: audio download failed for ${rec.id}`, dlErr);
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
    // Structured segments + optional summary for the triad's .json / .summary.md.
    let segments = detail.segments ?? [];
    let summaryText = detail.summaryText ?? '';
    let transcriptSource: 'plaud' | 'macparakeet' | 'none' = segments.length ? 'plaud' : 'none';
    // macparakeet history id — stored in the note so "Summarise" can run prompts.
    let parakeetId = '';

    if (hasRealTranscript(detail.transcriptText)) {
      transcription = parseServerTranscript(detail.transcriptText!);
      transcriptSource = 'plaud';
    } else if (this.plugin.app.vault.getAbstractFileByPath(bestAudioPath)) {
      // No Plaud transcript — transcribe locally with macparakeet.
      try {
        const vaultBasePath = (this.plugin.app.vault.adapter as any).getBasePath?.() ?? '';
        const audioAbsPath = join(vaultBasePath, bestAudioPath);
        const result = await this.plugin.whisperBridge.transcribeRich(
          audioAbsPath,
          this.plugin.settings,
        );
        transcription = { text: result.text, segments: result.segments.map(s => ({ start: s.start, end: s.end, text: s.text })), language: result.language };
        segments = result.segments.map(s => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
        transcriptSource = 'macparakeet';
        parakeetId = result.id ?? '';

        // Optionally summarize the fresh transcript via macparakeet + LLM.
        if (this.plugin.settings.parakeetSummaryEnabled && result.id) {
          try {
            this.setStatus({ state: 'transcribing', message: `(${index}/${total}) Summarizing "${label}"…`, recordingId: rec.id });
            summaryText = await this.plugin.whisperBridge.summarize(result.id, this.plugin.settings);
          } catch (sumErr: any) {
            console.warn(`Plaud: macparakeet summary failed for ${rec.id}`, sumErr);
          }
        }
      } catch (mpErr: any) {
        console.warn(`Plaud: macparakeet failed for ${rec.id}, creating note without transcript.`, mpErr);
        transcription = { text: '*(macparakeet transcription failed — check `macparakeet-cli health` and that it is installed.)*', segments: [] };
      }
    } else {
      transcription = { text: '*(No transcript available — no Plaud transcript and no audio to transcribe.)*', segments: [] };
    }

    // ── Create note ───────────────────────────────────────────────────────
    const notePath = await this.plugin.noteFactory.createNote(
      rec,
      detail,
      transcription,
      bestAudioPath,
      this.plugin.settings,
    );
    // Record the macparakeet transcription id in the note so the Summarise
    // command can run prompts against it later.
    if (parakeetId) {
      await setFrontmatterKey(this.plugin.app.vault, notePath, 'parakeet_id', parakeetId);
    }

    // ── Store structured transcript (JSON) + AI summary (Markdown) ──────────
    await writeTranscriptArtifacts(
      this.plugin.app.vault,
      rec,
      this.plugin.settings,
      segments,
      summaryText,
      transcriptSource,
    );

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
    // whole set of files (note + audio + .json + .summary.md) sharing that
    // note's stem in the triad folder.
    const noteFiles = vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder + '/') && !f.name.endsWith('.summary.md'),
    );
    let stem: string | null = null;
    for (const file of noteFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.plaud_id === id) {
        stem = file.basename; // note basename is the stem
        await vault.trash(file, true);
        break;
      }
    }

    // Delete all sibling files sharing the stem: <stem>.<ext>, <stem>.json,
    // <stem>.summary.md.
    if (stem) {
      const siblings = vault.getFiles().filter(f =>
        f.path.startsWith(folder + '/') &&
        (f.basename === stem || f.basename === `${stem}.summary`),
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
   * Summarise a note with a chosen macparakeet prompt, writing the result to the
   * triad's `<stem>.summary.md`. Resolves the macparakeet transcription id from
   * the note's `parakeet_id` frontmatter; if absent (e.g. a Plaud-only note), it
   * transcribes the triad audio once to obtain an id first.
   */
  async summarizeNote(file: TFile, promptName: string): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync in progress — try again after it finishes.');
      return;
    }
    const vault = this.plugin.app.vault;
    const folder = triadFolder(this.plugin.settings);
    const stem = file.basename;

    this.isSyncing = true;
    this.setStatus({ state: 'transcribing', message: `Summarising "${stem}"…` });
    try {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      let parakeetId = String(cache?.frontmatter?.parakeet_id ?? '').trim();

      // No id yet — transcribe the triad audio once to get one.
      if (!parakeetId) {
        const audio = vault.getFiles().find(f =>
          f.path.startsWith(folder + '/') && f.basename === stem && f.extension !== 'md' && f.extension !== 'json',
        );
        if (!audio) {
          new Notice('Plaud: no audio found to summarise this note.');
          return;
        }
        const vaultBasePath = (vault.adapter as any).getBasePath?.() ?? '';
        const absPath = join(vaultBasePath, audio.path);
        parakeetId = await this.plugin.whisperBridge.transcribeForId(absPath, this.plugin.settings);
        if (parakeetId) {
          await setFrontmatterKey(vault, file.path, 'parakeet_id', parakeetId);
        }
      }
      if (!parakeetId) {
        new Notice('Plaud: could not obtain a macparakeet transcription id.');
        return;
      }

      const summary = await this.plugin.whisperBridge.summarize(parakeetId, this.plugin.settings, promptName);
      if (!summary || summary.trim().length === 0) {
        new Notice('Plaud: summary produced no output.');
        return;
      }
      await writeFileOverwrite(vault, normalizePath(`${folder}/${stem}.summary.md`), summary.trim() + '\n');
      new Notice(`Plaud: summarised "${stem}" → ${stem}.summary.md`);
      this.setStatus({ state: 'idle', message: `Summarised: ${new Date().toLocaleTimeString()}` });
    } catch (err: any) {
      console.error('Plaud: summarise failed', err);
      new Notice(`Plaud: summarise error: ${err.message}`);
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
      'macparakeet transcription failed',
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
 * Persist Plaud's server-side artifacts into the triad:
 *  - `<ts>.json`         — structured transcript (speaker-labelled segments)
 *  - `<ts>.summary.md`   — Plaud's AI summary (Markdown)
 * Each is written only when the corresponding data is present. Files are
 * overwritten so re-syncs pick up updated transcripts/summaries.
 */
async function writeTranscriptArtifacts(
  vault: Vault,
  rec: PlaudFile,
  settings: import('../settings').PlaudSettings,
  segments: Array<{ start: number; end: number; text: string; speaker?: string; original_speaker?: string }>,
  summaryText: string,
  source: 'plaud' | 'macparakeet' | 'none',
): Promise<void> {
  if (Array.isArray(segments) && segments.length > 0) {
    const payload = {
      plaud_id: rec.id,
      name: (rec as any).name ?? rec.filename ?? rec.id,
      source,
      segments,
    };
    await writeFileOverwrite(
      vault,
      triadTranscriptJsonPath(rec, settings),
      JSON.stringify(payload, null, 2) + '\n',
    );
  }

  if (summaryText && summaryText.trim().length > 0) {
    await writeFileOverwrite(vault, triadSummaryPath(rec, settings), summaryText.trim() + '\n');
  }
}

/** Create or overwrite a vault file at `path` with `body`. */
async function writeFileOverwrite(vault: Vault, path: string, body: string): Promise<void> {
  const normalized = normalizePath(path);
  const existing = vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) {
    await vault.modify(existing, body);
  } else {
    await vault.create(normalized, body);
  }
}

/** Set (or replace) a single frontmatter key on a note. */
async function setFrontmatterKey(vault: Vault, notePath: string, key: string, value: string): Promise<void> {
  const file = vault.getAbstractFileByPath(notePath);
  if (!(file instanceof TFile)) return;
  let content = await vault.read(file);
  if (!content.startsWith('---\n')) return;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return;
  const head = content.slice(0, end);
  const line = `${key}: ${value}`;
  if (new RegExp(`\\n${key}:`).test(head)) {
    content = head.replace(new RegExp(`\\n${key}:[^\\n]*`), `\n${line}`) + content.slice(end);
  } else {
    content = head + `\n${line}` + content.slice(end);
  }
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
