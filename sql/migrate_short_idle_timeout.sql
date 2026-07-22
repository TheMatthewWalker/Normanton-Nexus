/* ============================================================
   Add ShortIdleTimeout to PortalUsers
   Run connected to the kongsberg database.

   Per-user override: when set, that user's session idle timeout is 5
   minutes instead of the portal-wide default (server.js — currently
   30 minutes). Toggled per user in User Administration. Read once at
   login into req.session.user.shortIdleTimeout — changing this flag
   takes effect on that user's next login, not their current session.
   ============================================================ */

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID(N'dbo.PortalUsers')
      AND  name      = N'ShortIdleTimeout'
)
    ALTER TABLE dbo.PortalUsers
        ADD ShortIdleTimeout BIT NOT NULL DEFAULT 0;
