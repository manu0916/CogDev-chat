import { describe, expect, it } from 'vitest';
import { rateLimitBucket } from '../../worker/rate-limit';

describe('rate limit windows', () => {
  it('uses stable fixed windows', () => {
    expect(rateLimitBucket(65_000, 60)).toBe(60);
    expect(rateLimitBucket(119_999, 60)).toBe(60);
    expect(rateLimitBucket(120_000, 60)).toBe(120);
  });
});
