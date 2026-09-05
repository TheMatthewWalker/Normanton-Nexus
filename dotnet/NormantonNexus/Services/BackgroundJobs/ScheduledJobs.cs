using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Helpers.ProductionSchedule;
using NormantonNexus.Helpers.Warehouse;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Notifications;
using NormantonNexus.Services.Sql;
using Quartz;

namespace NormantonNexus.Services.BackgroundJobs;

/// <summary>
/// Quartz.NET IJob wrappers around the cron entry points every earlier
/// department phase already ported as a callable Helper method but left
/// unscheduled — Phase 10 cross-cutting closeout, per the migration plan's
/// own "finish Quartz.NET jobs" instruction. Each job is a thin adapter: it
/// calls the exact same Helper method Node's server.js cron.schedule(...)
/// callback calls, catches and logs any failure rather than letting it
/// propagate (matching every one of those callbacks' own
/// `.then(...).catch(err => console.error(...))` shape), and does nothing
/// else — all the real logic already lives in, and was already tested in,
/// each Helper.
///
/// userId 0 is the shared service-token convention already established
/// throughout this migration for calls with no real portal-user context
/// (e.g. SapServer's own CustomsController doc comment: "only ever called
/// via the Node-side shared service token, userId 0") — a scheduled job has
/// no authenticated user to act as.
///
/// [DisallowConcurrentExecution] on every job mirrors the two refresh
/// Helpers' own in-flight-Task guards (RunTurnsValClassRefreshAsync/
/// RunMrpHistoryRefreshAsync) and adds the same protection to the ones that
/// don't already have it (RunFullRefreshAsync, matching Node's own
/// runFullRefresh, which has no guard of its own either) — a slow run
/// overlapping its own next scheduled fire is worse behavior here than in
/// Node, since Quartz's default trigger semantics would otherwise start a
/// second concurrent execution rather than skip it the way a still-pending
/// in-flight-Task guard does.
/// </summary>
internal static class CronUserId
{
    internal const int System = 0;
}

[DisallowConcurrentExecution]
public sealed class FullRefreshJob(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, ILogger<FullRefreshJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var results = await PerformanceSyncHelper.RunFullRefreshAsync(nexusDb, opsDb, sap, CronUserId.System, context.CancellationToken);
            logger.LogInformation("Scheduled refresh complete: {@Results}", results);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Scheduled refresh failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class TurnsValClassRefreshJob(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, ILogger<TurnsValClassRefreshJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var results = await PerformanceSyncHelper.RunTurnsValClassRefreshAsync(nexusDb, opsDb, sap, CronUserId.System, context.CancellationToken);
            logger.LogInformation("Scheduled turns-valclass refresh complete: {@Results}", results);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Scheduled turns-valclass refresh failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class MrpHistoryRefreshJob(INexusDb nexusDb, INexusOperationsDb opsDb, ISapServerClient sap, ILogger<MrpHistoryRefreshJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var result = await PerformanceSyncHelper.RunMrpHistoryRefreshAsync(nexusDb, opsDb, sap, CronUserId.System, context.CancellationToken);
            logger.LogInformation("Scheduled MRP Analysis history refresh complete: {@Result}", result);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Scheduled MRP Analysis history refresh failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class ConsignmentSyncJob(INexusOperationsDb opsDb, ISapServerClient sap, ILogger<ConsignmentSyncJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var results = await ConsignmentSapSyncHelper.RunDailySyncAsync(opsDb, sap, CronUserId.System, context.CancellationToken);
            logger.LogInformation("Scheduled consignment GR + stock sync complete: {@Results}", results);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Scheduled consignment GR + stock sync failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class IsoparDeclarationDueCheckJob(INexusDb nexusDb, INexusOperationsDb opsDb, INotificationService notify, ILogger<IsoparDeclarationDueCheckJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var result = await IsoparDeclarationHelper.CheckDeclarationDueAsync(nexusDb, opsDb, notify, context.CancellationToken);
            if (result.Notified)
                logger.LogInformation("Isopar declaration notification sent for period ending {PeriodEnd}", result.PeriodEnd);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Isopar declaration due check failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class ProductionScheduleOtifDiffJob(INexusOperationsDb opsDb, ILogger<ProductionScheduleOtifDiffJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var result = await ProductionScheduleHelper.DiffProductionScheduleOtifAsync(opsDb, context.CancellationToken);
            logger.LogInformation("Production schedule OTIF diff complete: {@Result}", result);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Production schedule OTIF diff failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class WarehouseSapSyncJob(INexusOperationsDb opsDb, ISapServerClient sap, ILogger<WarehouseSapSyncJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var result = await WarehouseSapSyncHelper.RunSapSyncAsync(opsDb, sap, WarehouseSapSyncHelper.ServiceUserId, context.CancellationToken);
            logger.LogInformation("Scheduled warehouse SAP sync complete: {@Result}", result);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Scheduled warehouse SAP sync failed");
        }
    }
}

[DisallowConcurrentExecution]
public sealed class SessionCleanupJob(ISessionCleanupService sessionCleanup, ILogger<SessionCleanupJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        try
        {
            var count = await sessionCleanup.CleanupExpiredAsync(context.CancellationToken);
            if (count > 0) logger.LogInformation("Session cleanup removed {Count} expired session(s)", count);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Session cleanup failed");
        }
    }
}
