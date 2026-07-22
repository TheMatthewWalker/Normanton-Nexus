/**
 * lib/sqlSessionStore.js
 *
 * SQL Server-backed express-session store.
 *
 * Why: server.js's session middleware previously used express-session's
 * default in-memory MemoryStore, so every server restart (scheduled
 * deploy, crash, manual bounce) instantly logged every user out — the
 * browser kept its connect.sid cookie, but the server no longer had any
 * record of the session it referred to, and the next request looked
 * unauthenticated. (private/js/session-guard.js papers over the
 * *symptom* — an ambiguous "invalid JSON" error on the next API call —
 * this store fixes the actual cause.)
 *
 * Persists sessions to the same SQL Server database the rest of the app
 * already talks to (kongsberg — see config.js's sqlConfig), reusing the
 * exact same connection pattern as the DB layer files under routes/
 * (sql.connect(sqlConfig), a cached pool per process). No new dependency
 * or infrastructure required.
 *
 * Table: kongsberg.dbo.PortalSessions — see sql/migrate_portal_sessions.sql.
 * Run that migration before deploying this.
 */

import session      from 'express-session';
import sql          from 'mssql';
import { sqlConfig } from '../config.js';

const Store = session.Store;

// server.js's session cookie has a 0.5-hour rolling idle timeout, but fall
// back to something sane if a session somehow arrives with no cookie.expires
// at all (shouldn't happen in practice — express-session always sets it).
const FALLBACK_TTL_MS = 30 * 60 * 1000;

function expiryOf(sessionData) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const d = new Date(expires);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() + FALLBACK_TTL_MS);
}

export class SqlSessionStore extends Store {
  constructor() {
    super();
  }

  async _pool() {
    return sql.connect(sqlConfig);
  }

  // ── get ──────────────────────────────────────────────────────────────────
  get(sid, callback) {
    this._pool()
      .then(pool => pool.request()
        .input('sid', sql.NVarChar(128), sid)
        .query(`
          SELECT SessionData
          FROM kongsberg.dbo.PortalSessions
          WHERE SessionID = @sid AND ExpiresUtc > SYSUTCDATETIME()
        `))
      .then(result => {
        const row = result.recordset[0];
        if (!row) return callback(null, null);
        try {
          callback(null, JSON.parse(row.SessionData));
        } catch (err) {
          callback(err);
        }
      })
      .catch(err => {
        console.error('[sqlSessionStore] get failed:', err.message);
        callback(err);
      });
  }

  // ── set ──────────────────────────────────────────────────────────────────
  set(sid, sessionData, callback) {
    const expiresUtc = expiryOf(sessionData);
    const data = JSON.stringify(sessionData);

    this._pool()
      .then(pool => pool.request()
        .input('sid',        sql.NVarChar(128),     sid)
        .input('data',       sql.NVarChar(sql.MAX),  data)
        .input('expiresUtc', sql.DateTime2,          expiresUtc)
        .query(`
          MERGE kongsberg.dbo.PortalSessions AS target
          USING (SELECT @sid AS SessionID) AS src
            ON target.SessionID = src.SessionID
          WHEN MATCHED THEN
            UPDATE SET SessionData = @data,
                       ExpiresUtc  = @expiresUtc,
                       UpdatedUtc  = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (SessionID, SessionData, ExpiresUtc, CreatedUtc, UpdatedUtc)
            VALUES (@sid, @data, @expiresUtc, SYSUTCDATETIME(), SYSUTCDATETIME());
        `))
      .then(() => callback(null))
      .catch(err => {
        console.error('[sqlSessionStore] set failed:', err.message);
        callback(err);
      });
  }

  // ── destroy ──────────────────────────────────────────────────────────────
  destroy(sid, callback) {
    this._pool()
      .then(pool => pool.request()
        .input('sid', sql.NVarChar(128), sid)
        .query(`DELETE FROM kongsberg.dbo.PortalSessions WHERE SessionID = @sid`))
      .then(() => callback(null))
      .catch(err => {
        console.error('[sqlSessionStore] destroy failed:', err.message);
        callback(err);
      });
  }

  // ── touch ────────────────────────────────────────────────────────────────
  // Called on (almost) every request because server.js sets `rolling: true`
  // — resets the idle timeout on activity rather than expiring a session the
  // user is actively using.
  touch(sid, sessionData, callback) {
    const expiresUtc = expiryOf(sessionData);

    this._pool()
      .then(pool => pool.request()
        .input('sid',        sql.NVarChar(128), sid)
        .input('expiresUtc', sql.DateTime2,      expiresUtc)
        .query(`
          UPDATE kongsberg.dbo.PortalSessions
          SET ExpiresUtc = @expiresUtc, UpdatedUtc = SYSUTCDATETIME()
          WHERE SessionID = @sid
        `))
      .then(() => callback(null))
      .catch(err => {
        console.error('[sqlSessionStore] touch failed:', err.message);
        callback(err);
      });
  }

  // ── cleanupExpired ───────────────────────────────────────────────────────
  // Not part of the express-session Store interface — server.js calls this
  // on a cron so the table doesn't grow unbounded with rows nobody will ever
  // read again (get() already ignores expired rows on its own, this is
  // purely housekeeping).
  async cleanupExpired() {
    const pool = await this._pool();
    const result = await pool.request().query(`
      DELETE FROM kongsberg.dbo.PortalSessions WHERE ExpiresUtc <= SYSUTCDATETIME()
    `);
    return result.rowsAffected?.[0] ?? 0;
  }
}

export default SqlSessionStore;
