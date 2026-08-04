// Jest `setupFiles` entry — runs before the test framework loads, for every test file.
//
// config.js reads several env vars at import time and throws immediately if
// they're missing (SAP_SERVER_SECRET, RESEND_API_KEY) — so anything that
// transitively imports config.js (which is most of the app) can't even be
// imported in a test without these set. Real dev/production values come from
// .env (see .env.example); tests never need real secrets, just values of the
// right shape, so these are only set if not already present in the
// environment — a real .env picked up by a developer's shell still wins.

process.env.SAP_SERVER_SECRET ??= 'test-sap-server-secret-not-real';
process.env.RESEND_API_KEY ??= 'test-resend-api-key-not-real';
// AES-256-GCM key for lib/sapCredentials.js — must decode to exactly 32 bytes.
process.env.SAP_CRED_ENCRYPTION_KEY ??= '00'.repeat(32);
