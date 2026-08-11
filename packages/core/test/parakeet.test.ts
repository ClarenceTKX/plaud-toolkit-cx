import { describe, it, expect } from 'vitest';
import { parseTranscription, mapParakeetSegments } from '../src/parakeet.js';

// Shape verified against a real `macparakeet-cli` history dump.
const realish = {
  id: '499CBDAC-1AE5-4147-9AAC-357D0157EAB8',
  language: 'en',
  durationMs: 167079,
  speakerCount: 2,
  rawTranscript: 'So we landed on those things...',
  speakers: [{ id: 'S1', label: 'Speaker 1' }, { id: 'S2', label: 'Speaker 2' }],
  transcriptSegments: [
    { startMs: 1200, endMs: 11120, speakerId: 'S1', speakerLabel: 'Speaker 1', text: 'So we landed on those things.' },
    { startMs: 11120, endMs: 20000, speakerId: 'S2', speakerLabel: 'Speaker 2', text: 'Right, and then we mapped it back.' },
    { startMs: 20000, endMs: 25000, speakerId: 'S1', speakerLabel: 'Speaker 1', text: 'Exactly.' },
  ],
};

describe('parseTranscription (macparakeet)', () => {
  const t = parseTranscription(realish);

  it('carries the history id (needed for summaries)', () => {
    expect(t.id).toBe('499CBDAC-1AE5-4147-9AAC-357D0157EAB8');
  });

  it('maps segments with ms→seconds and speaker labels', () => {
    expect(t.segments).toHaveLength(3);
    expect(t.segments[0]).toEqual({
      start: 1.2,
      end: 11.12,
      text: 'So we landed on those things.',
      speaker: 'Speaker 1',
      speakerId: 'S1',
    });
  });

  it('builds speaker-prefixed flat text (grouping same speaker)', () => {
    expect(t.text).toBe(
      'Speaker 1: So we landed on those things.\n' +
        'Speaker 2: Right, and then we mapped it back.\n' +
        'Speaker 1: Exactly.',
    );
  });

  it('surfaces language, durationMs, speakerCount', () => {
    expect(t.language).toBe('en');
    expect(t.durationMs).toBe(167079);
    expect(t.speakerCount).toBe(2);
  });

  it('falls back to rawTranscript when there are no segments', () => {
    const t2 = parseTranscription({ id: 'x', rawTranscript: 'hello world', transcriptSegments: [] });
    expect(t2.text).toBe('hello world');
    expect(t2.segments).toEqual([]);
  });
});

describe('mapParakeetSegments', () => {
  it('skips empty text and defaults missing bounds', () => {
    expect(
      mapParakeetSegments([
        { startMs: 1000, endMs: 2000, text: ' keep ', speakerLabel: 'Speaker 1', speakerId: 'S1' },
        { startMs: 2000, endMs: 3000, text: '  ' },
        { text: 'no bounds' },
      ]),
    ).toEqual([
      { start: 1, end: 2, text: 'keep', speaker: 'Speaker 1', speakerId: 'S1' },
      { start: 0, end: 0, text: 'no bounds' },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(mapParakeetSegments(undefined)).toEqual([]);
  });
});
