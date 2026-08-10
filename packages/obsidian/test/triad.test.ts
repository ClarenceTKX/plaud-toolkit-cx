import { describe, it, expect } from 'vitest';
import {
  triadFolder,
  triadStem,
  triadNotePath,
  triadAudioPath,
  triadLlmPath,
} from '../src/notes/triad';
import type { PlaudSettings } from '../src/settings';

const settings = { triadFolder: '__Support/Plaud' } as PlaudSettings;
const rec = { id: 'abc123', start_time: 1786344425271 } as any;

describe('triad paths', () => {
  it('uses start_time epoch-ms as the stem', () => {
    expect(triadStem(rec)).toBe('1786344425271');
  });

  it('falls back to a sanitized id when start_time is unusable', () => {
    expect(triadStem({ id: 'a/b c', start_time: NaN } as any)).toBe('a_b_c');
    expect(triadStem({ id: 'x', start_time: 0 } as any)).toBe('x');
  });

  it('builds note/audio/llm paths sharing one folder + stem', () => {
    expect(triadNotePath(rec, settings)).toBe('__Support/Plaud/1786344425271.md');
    expect(triadAudioPath(rec, settings, 'mp3')).toBe('__Support/Plaud/1786344425271.mp3');
    expect(triadAudioPath(rec, settings, '.wav')).toBe('__Support/Plaud/1786344425271.wav');
    expect(triadLlmPath(rec, settings)).toBe('__Support/Plaud/1786344425271.llm.md');
  });

  it('defaults the folder when unset', () => {
    expect(triadFolder({} as PlaudSettings)).toBe('__Support/Plaud');
    expect(triadFolder({ triadFolder: '  ' } as PlaudSettings)).toBe('__Support/Plaud');
    expect(triadFolder({ triadFolder: 'Voice/Notes' } as PlaudSettings)).toBe('Voice/Notes');
  });

  it('defaults a missing audio ext to mp3', () => {
    expect(triadAudioPath(rec, settings, '')).toBe('__Support/Plaud/1786344425271.mp3');
  });
});
