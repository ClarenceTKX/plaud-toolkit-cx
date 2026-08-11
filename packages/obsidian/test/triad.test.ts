import { describe, it, expect } from 'vitest';
import {
  triadFolder,
  triadStem,
  triadNotePath,
  triadAudioPath,
  triadTranscriptJsonPath,
  triadSummaryPath,
} from '../src/notes/triad';
import type { PlaudSettings } from '../src/settings';

const settings = { triadFolder: '__Support/Plaud' } as PlaudSettings;
const rec = {
  id: 'abc123',
  name: 'Q2 Review',
  start_at: '2026-04-01T12:00:00',
  created_at: '2026-04-01T13:00:00',
} as any;
const STEM = '2026-04-01_Q2_Review';

describe('triad paths', () => {
  it('uses the shared <date>_<slug> stem', () => {
    expect(triadStem(rec)).toBe(STEM);
  });

  it('builds note/audio/json/summary paths sharing one folder + stem', () => {
    expect(triadNotePath(rec, settings)).toBe(`__Support/Plaud/${STEM}.md`);
    expect(triadAudioPath(rec, settings, 'mp3')).toBe(`__Support/Plaud/${STEM}.mp3`);
    expect(triadAudioPath(rec, settings, '.wav')).toBe(`__Support/Plaud/${STEM}.wav`);
    expect(triadTranscriptJsonPath(rec, settings)).toBe(`__Support/Plaud/${STEM}.json`);
    expect(triadSummaryPath(rec, settings)).toBe(`__Support/Plaud/${STEM}.summary.md`);
  });

  it('defaults the folder when unset', () => {
    expect(triadFolder({} as PlaudSettings)).toBe('__Support/Plaud');
    expect(triadFolder({ triadFolder: '  ' } as PlaudSettings)).toBe('__Support/Plaud');
    expect(triadFolder({ triadFolder: 'Voice/Notes' } as PlaudSettings)).toBe('Voice/Notes');
  });

  it('defaults a missing audio ext to mp3', () => {
    expect(triadAudioPath(rec, settings, '')).toBe(`__Support/Plaud/${STEM}.mp3`);
  });
});
