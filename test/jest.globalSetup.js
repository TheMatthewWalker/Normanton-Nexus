// Jest `globalSetup` — runs once, before any test file, in the main process.
//
// config.js and server.js both synchronously read ./config.json at import
// time (see config.js line 1) and have no override mechanism for the path.
// config.json is git-ignored (each environment provides its own — see
// config.example.json), so a fresh checkout genuinely doesn't have one.
// Tests never talk to a real database (mssql is mocked at the module level),
// so the actual credential values below don't matter — only that the file
// exists with the shape config.js/server.js expect. Never overwrites a real
// developer config.
//
// If TEST_SQL_* env vars are set (staging SQL Server, for the
// *.integration.test.js suite — see test/helpers/stagingDb.js), sqlConfig
// below points at the real staging server instead of dummy values, so
// integration tests exercise the actual route code path (e.g. routes/auth.js
// login) against it end-to-end, not just raw queries run standalone.

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

const TEST_CONFIG = {
  sessionSecret: 'test-session-secret-not-real',
  apiKey: 'test-api-key-not-real',
  sqlConfig: {
    user:     process.env.TEST_SQL_USER     || 'test-user',
    password: process.env.TEST_SQL_PASSWORD || 'test-password',
    server:   process.env.TEST_SQL_SERVER   || 'test-server',
    database: process.env.TEST_SQL_DATABASE || 'kongsberg',
  },
  sapConfig: {
    system: 'TST',
    systemNumber: '00',
    client: '000',
    user: 'TEST_USER',
    password: 'test-password',
    lang: 'EN',
    url: 'https://test-sapserver.invalid',
  },
  printers: [],
};

export default async function globalSetup() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
  console.log('[jest.globalSetup] wrote a test-only config.json (none existed) — see test/jest.globalSetup.js');
}
