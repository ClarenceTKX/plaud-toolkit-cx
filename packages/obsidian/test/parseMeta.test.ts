import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  transcriptionFromMeta,
  mapSegments,
  type SuperwhisperMeta,
} from '../src/whisper/parseMeta';

/**
 * Redacted synthetic fixture mirroring a real Superwhisper 2.17.2 export
 * (Parakeet, voice-only "Default" mode). Field names, types, and structure
 * match a genuine `meta.json`; the transcript text is fake so no real recording
 * data is committed. Real exports (`*.meta.json`) are gitignored.
 */
const realMeta = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'sample.meta.sample.json'),
    'utf-8',
  ),
) as SuperwhisperMeta;

describe('transcriptionFromMeta — voice-only export (synthetic fixture)', () => {
  const t = transcriptionFromMeta(realMeta, '/tmp/recordings/1786344425271');

  it('falls back to `result` when no `llmResult` is present', () => {
    expect(realMeta).not.toHaveProperty('llmResult');
    expect(t.llmProcessed).toBe(false);
    expect(t.text).toBe(realMeta.result!.trim());
    expect(t.text.startsWith('So we landed on those things.')).toBe(true);
  });

  it('reads language from languageSelected', () => {
    expect(t.language).toBe('en');
  });

  it('maps every segment with trimmed text and numeric bounds', () => {
    expect(t.segments.length).toBe(realMeta.segments!.length);
    for (const s of t.segments) {
      expect(typeof s.start).toBe('number');
      expect(typeof s.end).toBe('number');
      expect(s.text).toBe(s.text.trim());
      expect(s.text.length).toBeGreaterThan(0);
    }
    // First segment: " So we landed on those things." → trimmed, 1.36 → 3.04
    expect(t.segments[0]).toEqual({
      start: 1.36,
      end: 3.04,
      text: 'So we landed on those things.',
    });
  });

  it('surfaces model, mode, datetime and duration (ms → seconds)', () => {
    expect(t.meta?.modelName).toBe('Parakeet Multilanguage');
    expect(t.meta?.modeName).toBe('Default');
    expect(t.meta?.datetime).toBe('2026-08-08T07:40:40');
    // duration 167078 ms → 167.078 s
    expect(t.meta?.durationSeconds).toBeCloseTo(167.078, 3);
  });

  it('records the recording folder', () => {
    expect(t.recordingFolder).toBe('/tmp/recordings/1786344425271');
  });
});

describe('transcriptionFromMeta — AI-processed mode', () => {
  it('prefers `llmResult` over `result` and flags llmProcessed', () => {
    const meta: SuperwhisperMeta = {
      result: 'raw voice transcript',
      llmResult: 'Polished AI summary.',
      languageSelected: 'en',
      segments: [{ text: ' hello ', start: 0, end: 1 }],
    };
    const t = transcriptionFromMeta(meta);
    expect(t.llmProcessed).toBe(true);
    expect(t.text).toBe('Polished AI summary.');
  });

  it('treats an empty-string llmResult as "no AI result"', () => {
    const meta: SuperwhisperMeta = { result: 'voice only', llmResult: '   ' };
    const t = transcriptionFromMeta(meta);
    expect(t.llmProcessed).toBe(false);
    expect(t.text).toBe('voice only');
  });
});

describe('mapSegments — edge cases', () => {
  it('returns [] for missing/non-array input', () => {
    expect(mapSegments(undefined)).toEqual([]);
    expect(mapSegments([])).toEqual([]);
  });

  it('skips entries without usable text and defaults missing bounds to 0', () => {
    const out = mapSegments([
      { text: '  keep me ', start: 2, end: 3 },
      { text: '   ', start: 3, end: 4 },
      { start: 4, end: 5 } as any,
      { text: 'no bounds' } as any,
    ]);
    expect(out).toEqual([
      { text: 'keep me', start: 2, end: 3 },
      { text: 'no bounds', start: 0, end: 0 },
    ]);
  });
});
