import { describe, expect, it } from 'vitest';
import { makeCursor, readCursor } from '../../worker/conversations';

const env = { RATE_LIMIT_SALT: 'a-long-random-test-secret' } as any;

describe('message history cursor', () => {
  it('round-trips only for the authorized conversation', async () => {
    const cursor = await makeCursor(env, 42, 180);
    expect(await readCursor(env, 42, cursor)).toBe(180);
    expect(await readCursor(env, 43, cursor)).toBeNull();
  });

  it('rejects a modified cursor', async () => {
    const cursor = await makeCursor(env, 42, 180);
    expect(await readCursor(env, 42, `${cursor.slice(0, -1)}x`)).toBeNull();
  });
});
