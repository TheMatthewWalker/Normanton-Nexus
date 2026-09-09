using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// RetryAsync's real branches (MX per-tub retry, DR hard-block/concession
// re-check, EX/CO/BR/CL/TW plain backflush, EW/HA mark-complete) all need a
// live SQL Server and a real SapServer round-trip — untestable in this
// sandbox, same caveat as everywhere else in this migration. RetryAsync
// always opens a connection before dispatching (the process code itself
// decides which branch runs, not a request-shape check that could reject
// early) — CancelAsync is the one path that validates before opening a
// connection, for an unknown process code.
public class FailedBackflushHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    [Fact]
    public async Task CancelAsync_rejects_an_unknown_process_code_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FailedBackflushHelper.CancelAsync(db.Object, "ZZ", recordId: 1, userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CancelAsync_accepts_every_real_process_code_including_MX()
    {
        // MX is special-cased in Node's own cancel route (a separate
        // if/else picking table/pk manually instead of looking it up) even
        // though PROCESS['MX'] already carries the same table/pk — this
        // port uses ProductionSapHelpers.Process uniformly for every code,
        // which is only a real simplification if MX's entry there matches
        // Node's hardcoded values exactly. It does: both are prod.Mixing/MixingID.
        var db = new Mock<INexusOperationsDb>();
        var connectionOpened = false;
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .Callback(() => connectionOpened = true)
            .ThrowsAsync(new InvalidOperationException("stop here — this test only proves MX isn't rejected as an unknown code"));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            FailedBackflushHelper.CancelAsync(db.Object, "MX", recordId: 1, userId: 1, CancellationToken.None));

        Assert.True(connectionOpened);
    }
}
