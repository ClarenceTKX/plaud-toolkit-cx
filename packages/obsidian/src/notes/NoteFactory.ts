import type { App } from 'obsidian';
import type { PlaudFile, PlaudFileDetail, TranscriptionResult } from '../types';
import type { PlaudSettings } from '../settings';
import { triadFolder, triadNotePath } from './triad';

export class NoteFactory {
  constructor(private app: App) {}

  async createNote(
    rec: PlaudFile,
    detail: PlaudFileDetail,
    transcription: TranscriptionResult,
    audioVaultPath: string,
    settings: PlaudSettings,
  ): Promise<string> {
    // Triad model: note lives in the shared triad folder under a timestamp stem
    // (`<ts>.md`), alongside its audio and optional `.llm.md`.
    await this.ensureFolder(triadFolder(settings));

    const notePath = triadNotePath(rec, settings);

    if (this.app.vault.getAbstractFileByPath(notePath)) {
      return notePath;
    }

    const content = this.renderTemplate(settings.noteTemplate, {
      rec,
      detail,
      transcription,
      audioVaultPath,
    });

    await this.app.vault.create(notePath, content);
    return notePath;
  }

  private renderTemplate(
    template: string,
    ctx: {
      rec: PlaudFile;
      detail: PlaudFileDetail;
      transcription: TranscriptionResult;
      audioVaultPath: string;
    },
  ): string {
    const { rec, transcription, audioVaultPath } = ctx;
    const date = epochMsToDate(rec.start_time);

    const timestamps = transcription.segments
      .map(s => `- **${formatTimestamp(s.start)}** — ${s.text}`)
      .join('\n');

    const vars: Record<string, string> = {
      id: rec.id,
      title: rec.filename ?? rec.id,
      date: `[[${formatDate(date)}]]`,
      time: formatTime(date),
      duration: formatDuration(rec.duration / 1000), // API sends ms
      audio_path: audioVaultPath,
      transcript: transcription.text,
      timestamps,
    };

    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch (_) {}
      }
    }
  }
}

function epochMsToDate(epochMs: number): Date {
  const d = new Date(epochMs);
  return isNaN(d.getTime()) ? new Date() : d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatTime(d: Date): string {
  return d.toTimeString().slice(0, 5).replace(':', '');
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
