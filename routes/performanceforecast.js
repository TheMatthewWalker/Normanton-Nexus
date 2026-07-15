// Predicted usage — a seasonal-index weighted forecast built from 36 months of consumption
// history (SapServer's TurnsValClassRow.ConsumptionHistory36, see PerformanceHelpers.cs).
//
// Why this exists: SAP's own demand forecast (demandForecast / Z_STOCK_REQ_LIST) only
// reflects orders that already exist in the system — in practice that's about 1-2 months
// of real visibility. Materials are bought from suppliers on a ~4-month lead time, so
// there's a 2+ month gap where SAP shows nothing but a purchase decision still has to be
// made. Predicted usage fills that gap with a statistical estimate based on how the
// material has actually been consumed historically.
//
// Method: classic seasonal-index decomposition (a standard demand-planning technique —
// separates "how much do we use right now" from "how does this particular calendar month
// typically differ from the yearly average").
//
//   1. baseLevel      = trailing 12-month average consumption (today's overall trend/level)
//   2. overallAverage = average consumption across the full 36-month window (long-run baseline)
//   3. seasonalIndex(targetMonth) = weighted average of that calendar month's historical
//      values from the last up-to-3 years (most recent year weighted 3x, then 2x, then 1x)
//      divided by overallAverage
//   4. predicted(targetMonth) = baseLevel * seasonalIndex(targetMonth)
//
// Multiplying a trend-aware level by a seasonal ratio (rather than just replaying whatever
// happened in that calendar month 1-3 years ago) means a rising or falling overall trend
// still comes through, while the *shape* of the year (which months run higher/lower) is
// still respected. Weighting recent years more heavily lets the seasonal pattern adapt
// gradually rather than being permanently anchored to whatever happened 3 years ago.

const YEAR_WEIGHTS = [3, 2, 1]; // most-recent-year first; renormalised over whichever years actually have data
const MAX_SEASONAL_INDEX = 4;   // safety clamp — stops a near-zero overallAverage (low-volume/sparse materials)
                                 // from amplifying noise into an absurd multiple of baseLevel

/**
 * @param {number[]} history36 36 months of consumption, oldest first, current month last
 *                             (index 35 = current month, index 0 = 35 months ago). This is
 *                             the same array shape returned as `consumptionHistory36` on
 *                             each row from GET /api/performance/turns-valclass.
 * @param {Date} [today]       reference date; defaults to now. Only used for array length/
 *                             bounds checking — the offset math below is calendar-agnostic.
 * @returns {number[]} 13-element predicted usage, index 0 = current month, index 12 = +12
 *                      months out — same shape/orientation as demandForecast, so both can
 *                      share the same chart timeline and SQL column layout.
 */
export function computePredictedUsage(history36) {
  const h = Array.isArray(history36) && history36.length === 36
    ? history36.map(v => Number(v) || 0)
    : new Array(36).fill(0);

  // offset: 0 = current month, negative = that many months ago. Valid range -35..0.
  // Returns null (not 0) outside that range so "no data that far back" can be
  // distinguished from "genuinely zero consumption that month".
  const valueAtOffset = (offset) => {
    const idx = 35 + offset;
    return idx >= 0 && idx < 36 ? h[idx] : null;
  };

  const baseLevel = average(h.slice(24, 36)); // last 12 months
  const overallAverage = average(h);          // full 36-month window

  const predicted = [];
  for (let k = 0; k <= 12; k++) {
    if (overallAverage <= 0) {
      predicted.push(0);
      continue;
    }

    const seasonalRaw = weightedSeasonalValue(k, valueAtOffset);
    const seasonalIndex = Math.min(MAX_SEASONAL_INDEX, seasonalRaw / overallAverage);

    predicted.push(Math.max(0, baseLevel * seasonalIndex));
  }

  return predicted;
}

// Same calendar month 1/2/3 years before the TARGET month (today + k), expressed as an
// offset from today: k-12, k-24, k-36. Averages whichever of those are actually available
// (early on, or for large k, the 3-years-back observation can fall just outside the
// 36-month window — that's fine, we just drop it and renormalise over what's left).
function weightedSeasonalValue(k, valueAtOffset) {
  const observations = [
    { value: valueAtOffset(k - 12), weight: YEAR_WEIGHTS[0] },
    { value: valueAtOffset(k - 24), weight: YEAR_WEIGHTS[1] },
    { value: valueAtOffset(k - 36), weight: YEAR_WEIGHTS[2] },
  ].filter(o => o.value !== null);

  if (!observations.length) return 0;

  const weightSum = observations.reduce((sum, o) => sum + o.weight, 0);
  return observations.reduce((sum, o) => sum + o.value * o.weight, 0) / weightSum;
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}
