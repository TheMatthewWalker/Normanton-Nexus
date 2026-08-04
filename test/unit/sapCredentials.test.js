// lib/sapCredentials.js encrypts/decrypts each portal user's own SAP
// password at rest (AES-256-GCM) — this is genuinely security-sensitive
// code, worth testing directly: the encrypt/decrypt round trip, that
// tampered ciphertext fails LOUDLY (GCM auth tag) rather than silently
// decrypting to garbage, and the DB helper functions against a mocked
// mssql pool. The missing/wrong-length encryption key error paths are
// covered separately in sapCredentials.badKey.test.js, since
// SAP_CRED_ENCRYPTION_KEY is captured as a module-level constant in
// config.js at first import and jest.setupEnv.js already seeds a valid
// key for every test file by the time this one's imports run.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let sapCredentials;

beforeAll(async () => {
  sapCredentials = await import('../../lib/sapCredentials.js');
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('encryptSapPassword / decryptSapPassword', () => {
  test('round-trips a password through encryption and decryption', () => {
    const encrypted = sapCredentials.encryptSapPassword('S3cretPW!');
    expect(sapCredentials.decryptSapPassword(encrypted)).toBe('S3cretPW!');
  });

  test('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    const a = sapCredentials.encryptSapPassword('same-password');
    const b = sapCredentials.encryptSapPassword('same-password');
    expect(a).not.toBe(b);
    expect(sapCredentials.decryptSapPassword(a)).toBe('same-password');
    expect(sapCredentials.decryptSapPassword(b)).toBe('same-password');
  });

  test('tampered ciphertext fails loudly (GCM auth tag) instead of decrypting to garbage', () => {
    const encrypted = sapCredentials.encryptSapPassword('S3cretPW!');
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = buf.toString('base64');
    expect(() => sapCredentials.decryptSapPassword(tampered)).toThrow();
  });
});

describe('getSapCredentialStatus', () => {
  test('reports hasCredentials:true without ever returning the password', async () => {
    queueResults({ recordset: [{ SapUsername: 'J.SMITH', SapPasswordEncrypted: 'xyz', SapCredentialUpdatedAt: '2026-01-01' }] });
    const status = await sapCredentials.getSapCredentialStatus(101);
    expect(status).toEqual({ sapUsername: 'J.SMITH', hasCredentials: true, updatedAt: '2026-01-01' });
    expect(JSON.stringify(status)).not.toContain('xyz');
  });

  test('reports hasCredentials:false when nothing is configured', async () => {
    queueResults({ recordset: [{ SapUsername: null, SapPasswordEncrypted: null, SapCredentialUpdatedAt: null }] });
    const status = await sapCredentials.getSapCredentialStatus(101);
    expect(status).toEqual({ sapUsername: null, hasCredentials: false, updatedAt: null });
  });

  test('reports hasCredentials:false when the user row does not exist at all', async () => {
    queueResults({ recordset: [] });
    const status = await sapCredentials.getSapCredentialStatus(999);
    expect(status).toEqual({ sapUsername: null, hasCredentials: false, updatedAt: null });
  });
});

describe('setSapCredentials / clearSapCredentials', () => {
  test('encrypts the password before writing it', async () => {
    queueResults({ recordset: [] });
    await sapCredentials.setSapCredentials(101, ' J.SMITH ', 'S3cretPW!');
    const usernameInput = dbRequest.input.mock.calls.find(c => c[0] === 'username');
    const encryptedInput = dbRequest.input.mock.calls.find(c => c[0] === 'encrypted');
    expect(usernameInput[2]).toBe('J.SMITH'); // trimmed
    expect(encryptedInput[2]).not.toBe('S3cretPW!');
    expect(sapCredentials.decryptSapPassword(encryptedInput[2])).toBe('S3cretPW!');
  });

  test('clearSapCredentials nulls out all three columns for the user', async () => {
    queueResults({ recordset: [] });
    await sapCredentials.clearSapCredentials(101);
    expect(dbRequest.query.mock.calls[0][0]).toContain('SapUsername = NULL, SapPasswordEncrypted = NULL, SapCredentialUpdatedAt = NULL');
    expect(dbRequest.input).toHaveBeenCalledWith('userId', expect.anything(), 101);
  });
});

describe('getDecryptedSapCredentials', () => {
  test('returns the decrypted password for later one-shot use', async () => {
    const encrypted = sapCredentials.encryptSapPassword('S3cretPW!');
    queueResults({ recordset: [{ SapUsername: 'J.SMITH', SapPasswordEncrypted: encrypted }] });
    const creds = await sapCredentials.getDecryptedSapCredentials(101);
    expect(creds).toEqual({ sapUsername: 'J.SMITH', sapPassword: 'S3cretPW!' });
  });

  test('returns null when the user has not configured SAP credentials', async () => {
    queueResults({ recordset: [{ SapUsername: null, SapPasswordEncrypted: null }] });
    const creds = await sapCredentials.getDecryptedSapCredentials(101);
    expect(creds).toBeNull();
  });

  test('returns null when the user row does not exist', async () => {
    queueResults({ recordset: [] });
    const creds = await sapCredentials.getDecryptedSapCredentials(999);
    expect(creds).toBeNull();
  });
});
