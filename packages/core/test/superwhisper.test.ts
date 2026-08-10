import { describe, it, expect } from 'vitest';
import { transcriptionFromMeta, mapSegments } from '../src/superwhisper.js';

describe('transcriptionFromMeta', () => {
  it('falls back to result when no llmResult (voice-only mode)', () => {
    const meta = {
      result: 'raw voice transcript',
      languageSelected: 'en',
      duration: 167078,
      modelName: 'Parakeet Multilanguage',
      modeName: 'Default',
      segments: [{ text: ' hello ', start: 1.36, end: 3.04 }],
    };
    const t = transcriptionFromMeta(meta, '/tmp/rec/1');
    expect(t.llmProcessed).toBe(false);
    expect(t.text).toBe('raw voice transcript');
    expect(t.language).toBe('en');
    expect(t.recordingFolder).toBe('/tmp/rec/1');
    expect(t.meta?.durationSeconds).toBeCloseTo(167.078, 3);
    expect(t.meta?.modelName).toBe('Parakeet Multilanguage');
    expect(t.segments[0]).toEqual({ start: 1.36, end: 3.04, text: 'hello' });
  });

  it('prefers llmResult and flags llmProcessed', () => {
    const t = transcriptionFromMeta({ result: 'voice', llmResult: 'Polished.' });
    expect(t.llmProcessed).toBe(true);
    expect(t.text).toBe('Polished.');
  });

  it('treats empty llmResult as not processed', () => {
    const t = transcriptionFromMeta({ result: 'voice only', llmResult: '   ' });
    expect(t.llmProcessed).toBe(false);
    expect(t.text).toBe('voice only');
  });
});

describe('mapSegments', () => {
  it('skips empty text and defaults missing bounds', () => {
    expect(
      mapSegments([
        { text: ' keep ', start: 2, end: 3 },
        { text: '  ' },
        { text: 'no bounds' } as any,
      ]),
    ).toEqual([
      { text: 'keep', start: 2, end: 3 },
      { text: 'no bounds', start: 0, end: 0 },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(mapSegments(undefined)).toEqual([]);
  });
});
