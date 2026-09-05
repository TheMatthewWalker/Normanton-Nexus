namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Stores working hours (Needed By lead time) — pure date/time math, port
/// of routes/staging.js's isStoresWorkingDay/atLocalTime/nextStoresOpen/
/// clampToStoresWindow/previousStoresClose/snapToStoresWindow/
/// addStoresLeadTime/formatStoresTime/formatLocalDateTime. Stores only work
/// 05:45-17:00, Monday-Friday - no weekend shift. The 4-hour minimum lead
/// time is counted in *working* time, not flat clock time: a request
/// raised outside that window (evenings, nights, weekends) has its 4 hours
/// start from the next 05:45 open rather than landing at some hour nobody's
/// there to see, and a request raised close to the 17:00 close has the
/// overflow carry over into the next working day's morning.
///
/// DEVIATION FLAG, not fixed: every method here operates on plain local
/// wall-clock DateTime arithmetic (DayOfWeek/Hour/Minute), exactly mirroring
/// Node's own getDay()/setHours() (never getUTCDay()/setUTCHours()) - even
/// though the values that flow through this (dueAtUtc, etc.) are named and
/// stored as if UTC (GETUTCDATE() elsewhere in this same feature). This
/// looks like a naming mismatch but may be intentional (the server and the
/// physical Stores building are in the same timezone, so "local server
/// time" and "the real Stores opening hours" are meant to coincide) -
/// ported faithfully rather than silently "fixed" to real UTC arithmetic,
/// since changing it would change which wall-clock hour a request's
/// deadline actually lands on for real users, and this was never confirmed
/// as a defect the way the Goods Issue Items gap was.
/// </summary>
internal static class StoresWorkingHoursHelper
{
    private const int OpenHour = 5, OpenMinute = 45;
    private const int CloseHour = 17, CloseMinute = 0;

    internal const int NeededByMinLeadHours = 4;
    internal const int NeededByGraceMinutes = 5;

    internal static bool IsStoresWorkingDay(DateTime date) =>
        date.DayOfWeek is DayOfWeek.Monday or DayOfWeek.Tuesday or DayOfWeek.Wednesday or DayOfWeek.Thursday or DayOfWeek.Friday;

    internal static DateTime AtLocalTime(DateTime date, int hours, int minutes) =>
        new(date.Year, date.Month, date.Day, hours, minutes, 0, date.Kind);

    /// <summary>Next instant at/after `date` that Stores are open — same day if `date` is before today's open, otherwise the following working day's 05:45.</summary>
    internal static DateTime NextStoresOpen(DateTime date)
    {
        var d = AtLocalTime(date, OpenHour, OpenMinute);
        if (d < date) d = d.AddDays(1);
        while (!IsStoresWorkingDay(d)) d = d.AddDays(1);
        return d;
    }

    /// <summary>Rolls `date` forward to the next moment Stores are actually open - unchanged if `date` already falls inside today's working window.</summary>
    internal static DateTime ClampToStoresWindow(DateTime date)
    {
        if (IsStoresWorkingDay(date))
        {
            var open = AtLocalTime(date, OpenHour, OpenMinute);
            var close = AtLocalTime(date, CloseHour, CloseMinute);
            if (date >= open && date < close) return date;
        }
        return NextStoresOpen(date);
    }

    /// <summary>Closing instant of the most recent working day at/before `date`.</summary>
    internal static DateTime PreviousStoresClose(DateTime date)
    {
        var d = AtLocalTime(date, CloseHour, CloseMinute);
        if (d > date) d = d.AddDays(-1);
        while (!IsStoresWorkingDay(d)) d = d.AddDays(-1);
        return d;
    }

    /// <summary>Snaps an arbitrary Needed By pick to the nearest usable instant: inside today's window unchanged; within the minimum lead time of the previous close, pulled back to that close ("as soon as possible today"); otherwise pushed forward to the next working day's open.</summary>
    internal static DateTime SnapToStoresWindow(DateTime date)
    {
        if (IsStoresWorkingDay(date))
        {
            var open = AtLocalTime(date, OpenHour, OpenMinute);
            var close = AtLocalTime(date, CloseHour, CloseMinute);
            if (date >= open && date < close) return date;
        }
        var prevClose = PreviousStoresClose(date);
        if (date - prevClose <= TimeSpan.FromHours(NeededByMinLeadHours)) return prevClose;
        return NextStoresOpen(date);
    }

    /// <summary>Adds `hours` of Stores working time to `fromDate`, rolling any time past 17:00 over to the next working day's 05:45 (weekends skipped).</summary>
    internal static DateTime AddStoresLeadTime(DateTime fromDate, double hours)
    {
        var cursor = ClampToStoresWindow(fromDate);
        var remaining = TimeSpan.FromHours(hours);
        while (remaining > TimeSpan.Zero)
        {
            var close = AtLocalTime(cursor, CloseHour, CloseMinute);
            var available = close - cursor;
            if (remaining <= available)
            {
                cursor += remaining;
                remaining = TimeSpan.Zero;
            }
            else
            {
                remaining -= available;
                cursor = NextStoresOpen(close.AddMilliseconds(1));
            }
        }
        return cursor;
    }

    internal static string FormatStoresTime(DateTime date) => $"{date.Day:D2}/{date.Month:D2} {date.Hour:D2}:{date.Minute:D2}";

    /// <summary>Full local date/time (DD/MM/YYYY HH:MM) - for contexts spanning more than one year (the KPI export), where FormatStoresTime's day/month-only form would be ambiguous.</summary>
    internal static string FormatLocalDateTime(DateTime date) => $"{date.Day:D2}/{date.Month:D2}/{date.Year} {date.Hour:D2}:{date.Minute:D2}";
}
