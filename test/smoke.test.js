import { describe, test, expect } from '@jest/globals';

describe('jest + ESM smoke test', () => {
  test('runs a basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  test('supports native ESM imports', async () => {
    const { requireLogin } = await import('../middleware/auth.js');
    expect(typeof requireLogin).toBe('function');
  });
});
