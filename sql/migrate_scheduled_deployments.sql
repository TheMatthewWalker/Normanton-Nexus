/* ============================================================
   Scheduled deployments — run against the kongsberg database.

   dbo.ScheduledDeployments — admin-scheduled "git pull + restart the
   Normanton Nexus Windows Service" jobs. A node-cron checker in server.js
   polls this table every minute; when a row is due it flips Status to
   'running' and hands off to deploy-runner.cjs (a detached child process —
   see that file for why it must be detached).

   Status lifecycle: pending -> running -> completed | failed
                      pending -> cancelled (via admin UI, before it's due)
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM sys.objects
               WHERE object_id = OBJECT_ID(N'dbo.ScheduledDeployments') AND type = 'U')
BEGIN
  CREATE TABLE dbo.ScheduledDeployments (
    DeploymentID      INT           NOT NULL IDENTITY(1,1),
    ScheduledAt       DATETIME      NOT NULL,               -- when the restart should fire
    GitRef            NVARCHAR(100) NOT NULL DEFAULT 'main', -- branch to pull
    WarningMinutes    INT           NOT NULL DEFAULT 15,     -- how long before ScheduledAt the in-app banner starts showing
    Status            NVARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|cancelled
    Notes             NVARCHAR(500) NULL,                    -- optional admin-facing description shown in the banner

    CreatedByUserID   INT           NULL,
    CreatedByUsername NVARCHAR(80)  NULL,
    CreatedAt         DATETIME      NOT NULL DEFAULT GETDATE(),

    StartedAt         DATETIME      NULL,
    CompletedAt       DATETIME      NULL,
    OutputLog         NVARCHAR(MAX) NULL,                    -- git pull output on success
    ErrorMessage      NVARCHAR(MAX) NULL,                    -- failure detail

    CancelledAt       DATETIME      NULL,
    CancelledBy       NVARCHAR(80)  NULL,

    CONSTRAINT PK_ScheduledDeployments PRIMARY KEY (DeploymentID)
  );

  CREATE INDEX IX_ScheduledDeployments_DueCheck ON dbo.ScheduledDeployments (Status, ScheduledAt);

  PRINT 'Created dbo.ScheduledDeployments';
END
ELSE
  PRINT 'dbo.ScheduledDeployments already exists — skipped';


/* ── Verify ──────────────────────────────────────────────────────────────── */
SELECT 'ScheduledDeployments' AS TableName, COUNT(*) AS Rows FROM dbo.ScheduledDeployments;
