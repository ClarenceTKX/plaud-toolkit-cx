import { describe, it, expect } from 'vitest';
import { recordingStem, slugify } from '../src/naming.js';

describe('recordingStem', () => {
  it('builds <date>_<slug> from start_at', () => {
    expect(
      recordingStem({
        id: 'abc',
        name: '07-16 Meeting: Hands-Free AI Assistant',
        start_at: '2026-07-16T09:00:00',
        created_at: '2026-07-16T10:00:00',
      }),
    ).toBe('2026-07-16_07_16_Meeting_Hands_Free_AI_Assistant');
  });

  it('falls back to created_at when start_at is missing', () => {
    expect(
      recordingStem({ id: 'abc', name: 'Welcome to Plaud.ai', created_at: '2026-06-08T00:00:00' }),
    ).toBe('2026-06-08_Welcome_to_Plaud_ai');
  });

  it('uses "unknown" date when no valid ISO time', () => {
    expect(recordingStem({ id: 'xyz', name: 'Note', created_at: '' })).toBe('unknown_Note');
  });

  it('falls back to a sanitized id when name is empty', () => {
    expect(recordingStem({ id: 'a/b c', name: '', start_at: '2026-01-01T00:00:00' })).toBe(
      '2026-01-01_a_b_c',
    );
  });

  it('is identical for the same recording regardless of caller (CLI == Obsidian)', () => {
    const rec = { id: 'r1', name: 'Q2 Review', start_at: '2026-04-01T12:00:00', created_at: '2026-04-01T13:00:00' };
    expect(recordingStem(rec)).toBe(recordingStem({ ...rec }));
  });
});

describe('slugify', () => {
  it('collapses non-alphanumerics and caps at 50 chars', () => {
    expect(slugify('Hello,  World!! —')).toBe('Hello_World');
    expect(slugify('x'.repeat(80)).length).toBe(50);
  });
  it('handles undefined', () => {
    expect(slugify(undefined)).toBe('');
  });
});
