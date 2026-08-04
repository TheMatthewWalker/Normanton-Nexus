// Separate file from sapCredentials.test.js: config.js captures
// SAP_CRED_ENCRYPTION_KEY as a module-level constant the first time it's
// imported, and jest.setupEnv.js seeds a valid dummy key for every test
// file before that first import happens. To exercise resolveKey()'s error
// paths (missing key / wrong-decoded-length key), the env var must be
// broken BEFORE config.js is ever imported in this file's own module
// registry — which is why this lives in its own file rather than
// alongside the main suite.

import { describe, test, expect, beforeAll } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql } from '../helpers/mockPool.js';

const { sqlModule } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

describe('resolveKey() error paths', () => {
  test('throws a clear error when SAP_CRED_ENCRYPTION_KEY is not set at all', async () => {
    delete process.env.SAP_CRED_ENCRYPTION_KEY;
    const { encryptSapPassword } = await import('../../lib/sapCredentials.js');
    expect(() => encryptSapPassword('x')).toThrow(/SAP_CRED_ENCRYPTION_KEY env var is not set/);
  });
});
