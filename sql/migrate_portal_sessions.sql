/* ============================================================
   Persistent session store — run against the kongsberg database.

   dbo.PortalSessions — backs lib/sqlSessionStore.js, a SQL Server-backed
   express-session store. Replaces express-session's
   default in-memory MemoryStore, which loses every logged-in session
   the instant the Node process restarts (scheduled deploy, crash,
   manual bounce) — the browser keeps its connect.sid cookie, but the
   server has no record of what it refers to, and the next request
   from that browser looks unauthenticated even though the human is
   still "logged in" from their point of view.

   One row per active session. SessionID is the express-session ID
   (the value inside the signed connect.sid cookie); SessionData is
   the JSON-serialised session object (same shape express-session
   already keeps in memory). ExpiresUtc mirrors the session cookie's
   own expiry (server.js: 0.5-hour rolling idle timeout) so an expired
   row is indistinguishable from "not logged in" without needing a
   separate reaper process to run first — the store's own get() query
   filters on ExpiresUtc, and a periodic cleanup (server.js cron) just
   keeps the table from growing unbounded with rows nobody will ever
   read again.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.PortalSessions') AND type = 'U')
BEGIN
  CREATE TABLE dbo.PortalSessions (
    SessionID   NVARCHAR(128)  NOT NULL,
    SessionData NVARCHAR(MAX)  NOT NULL,
    ExpiresUtc  DATETIME2      NOT NULL,
    CreatedUtc  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedUtc  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_PortalSessions PRIMARY KEY (SessionID)
  );

  CREATE INDEX IX_PortalSessions_Expires ON dbo.PortalSessions (ExpiresUtc);

  PRINT 'Created dbo.PortalSessions';
END
ELSE
  PRINT 'dbo.PortalSessions already exists — skipped';


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'PortalSessions' AS TableName, COUNT(*) AS Rows FROM dbo.PortalSessions;
