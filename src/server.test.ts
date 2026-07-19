import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodError } from './server.js';

describe('formatZodError', () => {
  it('flattens issues into a readable "field: message" list instead of raw JSON', () => {
    const schema = z.object({ collectionId: z.string(), count: z.number() });
    const result = schema.safeParse({ count: 'not-a-number' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const out = formatZodError(result.error);
    expect(out).toMatch(/^Invalid arguments:/);
    expect(out).toContain('collectionId');
    expect(out).toContain('count');
    // Not a raw JSON issue array.
    expect(out).not.toContain('[{');
  });

  it('labels a root-level (refinement) issue as (arguments)', () => {
    const schema = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((v) => v.a === v.b, { message: 'a and b must match' });
    const result = schema.safeParse({ a: 'x', b: 'y' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const out = formatZodError(result.error);
    expect(out).toContain('(arguments): a and b must match');
  });
});
