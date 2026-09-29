import { describe, expect, it } from 'vitest';

const frontendModules = import.meta.glob('../../src/**/*.{ts,tsx,css}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('public bundle boundary', () => {
  it('does not reference private C6 credentials from frontend source', () => {
    const publicSource = Object.values(frontendModules).join('\n');
    expect(publicSource).not.toMatch(/C6_CLIENT_SECRET|C6_WEBHOOK_SECRET|C6_CLIENT_ID/);
    expect(publicSource).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/);
  });
});
