  CREATE TABLE dbo.FinanceGlGroups (
    GroupID    INT IDENTITY(1,1) PRIMARY KEY,
    GroupLabel NVARCHAR(100) NOT NULL,
    SortOrder  INT NOT NULL DEFAULT 0,
    CreatedAt  DATETIME NOT NULL DEFAULT GETDATE()
  );

  CREATE TABLE dbo.FinanceGlGroupAccounts (
    AccountID INT IDENTITY(1,1) PRIMARY KEY,
    GroupID   INT NOT NULL REFERENCES dbo.FinanceGlGroups(GroupID) ON DELETE CASCADE,
    GlAccount NVARCHAR(20) NOT NULL,
    SortOrder INT NOT NULL DEFAULT 0
  );