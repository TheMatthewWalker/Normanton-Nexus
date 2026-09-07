// Isopar Tied Oil tile — meter reading CRUD, stock risk, planning rate, and
// (for users who also hold ISOPAR_DECL) HMRC declaration review/submission.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }

  // ── Meter readings ──────────────────────────────────────────────
  async function loadReadings() {
    const el = document.getElementById("iso-readings");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/isopar/readings");
      renderReadings(data || []);
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  function renderReadings(rows) {
    const el = document.getElementById("iso-readings");
    el.innerHTML = rows.length === 0 ? "<p>No readings.</p>" : `
      <table>
        <thead><tr><th>Date</th><th>Reading (L)</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${fmtDate(r.readingDate)}</td>
              <td>${esc(r.readingQty)}</td>
              <td>${esc(r.notes)}</td>
              <td><button type="button" class="btn secondary" data-id="${r.readingId}">Delete</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this reading?")) return;
        try {
          await api(`/isopar/readings/${btn.dataset.id}`, { method: "DELETE" });
          await Promise.all([loadReadings(), loadStockRisk()]);
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  }

  document.getElementById("iso-reading-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/isopar/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readingDate: document.getElementById("iso-date").value || null,
          readingQty: Number(document.getElementById("iso-qty").value),
          notes: document.getElementById("iso-notes").value || null,
        }),
      });
      e.target.reset();
      await Promise.all([loadReadings(), loadStockRisk()]);
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Stock risk ──────────────────────────────────────────────────
  async function loadStockRisk() {
    const el = document.getElementById("iso-risk");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/isopar/stock-risk");
      if (!data) {
        el.innerHTML = "<p>No stock risk data available (no readings yet).</p>";
        return;
      }
      el.innerHTML = `
        <table>
          <tbody>
            <tr><th>As Of</th><td>${fmtDate(data.asOfDate)}</td></tr>
            <tr><th>Current Stock</th><td>${esc(data.currentStock)} L</td></tr>
            <tr><th>Max Capacity</th><td>${data.maxStockCapacityQty != null ? esc(data.maxStockCapacityQty) + " L" : "—"}</td></tr>
            <tr><th>Projected Stockout</th><td>${data.stockoutDate ? fmtDate(data.stockoutDate) : "—"}</td></tr>
            <tr><th>Projected Over-Capacity</th><td>${data.overCapacityDate ? fmtDate(data.overCapacityDate) : "—"}</td></tr>
          </tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  // ── Planning rate ───────────────────────────────────────────────
  let lastRecommendation = null;

  async function loadPlanningRate() {
    const el = document.getElementById("iso-rate");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/isopar/planning-rate");
      lastRecommendation = data.recommendation || null;
      const cur = data.current;
      const act = data.actual;
      el.innerHTML = `
        <table>
          <tbody>
            <tr><th>Current Weekday Rate</th><td>${cur ? esc(cur.weekdayRateLPerDay) + " L/day" : "—"}</td></tr>
            <tr><th>Current Weekend Rate</th><td>${cur ? esc(cur.weekendRateLPerDay) + " L/day" : "—"}</td></tr>
            <tr><th>Actual Weekday Avg</th><td>${act.weekdayAvgLPerDay != null ? esc(act.weekdayAvgLPerDay) + " L/day" : "—"}</td></tr>
            <tr><th>Actual Weekend Avg</th><td>${act.weekendAvgLPerDay != null ? esc(act.weekendAvgLPerDay) + " L/day" : "—"}</td></tr>
            <tr><th>Sample Intervals</th><td>${esc(act.sampleIntervals)}</td></tr>
            <tr><th>Recommendation</th><td>${data.recommendation ? `${esc(data.recommendation.weekdayRateLPerDay)} / ${esc(data.recommendation.weekendRateLPerDay)} L/day (weekday/weekend)` : "—"}</td></tr>
          </tbody>
        </table>`;
      if (cur) {
        document.getElementById("iso-rate-weekday").value = cur.weekdayRateLPerDay;
        document.getElementById("iso-rate-weekend").value = cur.weekendRateLPerDay;
        document.getElementById("iso-rate-capacity").value = cur.maxStockCapacityQty ?? "";
        document.getElementById("iso-rate-source").value = cur.source ?? "";
        document.getElementById("iso-rate-notes").value = cur.notes ?? "";
      }
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  document.getElementById("iso-rate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/isopar/planning-rate", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekdayRateLPerDay: Number(document.getElementById("iso-rate-weekday").value),
          weekendRateLPerDay: Number(document.getElementById("iso-rate-weekend").value),
          maxStockCapacityQty: document.getElementById("iso-rate-capacity").value ? Number(document.getElementById("iso-rate-capacity").value) : null,
          source: document.getElementById("iso-rate-source").value || null,
          notes: document.getElementById("iso-rate-notes").value || null,
        }),
      });
      await Promise.all([loadPlanningRate(), loadStockRisk()]);
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  document.getElementById("iso-rate-apply-recommended").addEventListener("click", async () => {
    if (!lastRecommendation) {
      alert("No recommendation available yet.");
      return;
    }
    try {
      await api("/isopar/planning-rate", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekdayRateLPerDay: lastRecommendation.weekdayRateLPerDay,
          weekendRateLPerDay: lastRecommendation.weekendRateLPerDay,
        }),
      });
      await Promise.all([loadPlanningRate(), loadStockRisk()]);
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── HMRC declarations (ISOPAR_DECL only — hidden entirely on 403) ─
  function renderPeriodFigures(f) {
    return `
      <table>
        <tbody>
          <tr><th>Period</th><td>${fmtDate(f.periodStart)} &ndash; ${fmtDate(f.periodEnd)}</td></tr>
          <tr><th>Opening Stock</th><td>${f.openingStockQty != null ? esc(f.openingStockQty) + " L" : "—"}</td></tr>
          <tr><th>Closing Stock</th><td>${f.closingStockQty != null ? esc(f.closingStockQty) + " L" : "—"}</td></tr>
          <tr><th>Received</th><td>${esc(f.receivedQty)} L</td></tr>
          <tr><th>Consumed</th><td>${f.consumedQty != null ? esc(f.consumedQty) + " L" : "—"}</td></tr>
          <tr><th>Deliveries</th><td>${f.deliveries.length}</td></tr>
          <tr><th>Complete</th><td>${f.complete ? "Yes" : "No — missing opening or closing reading"}</td></tr>
        </tbody>
      </table>`;
  }

  async function loadDeclarations() {
    const outEl = document.getElementById("iso-decl-outstanding");
    const histEl = document.getElementById("iso-decl-history");
    try {
      const [outstanding, history] = await Promise.all([
        api("/isopar/declarations/outstanding"),
        api("/isopar/declarations"),
      ]);
      document.getElementById("iso-decl-section").style.display = "";

      const periods = outstanding.data || [];
      outEl.innerHTML = periods.length === 0 ? "<p>No outstanding periods.</p>" :
        periods.map((p) => `
          <div class="card" data-idx="${p.index}" style="margin-bottom:0.75rem;">
            ${renderPeriodFigures(p.figures)}
            <button type="button" class="btn secondary" data-submit="${p.index}" ${p.figures.complete ? "" : "disabled"}>Confirm & Submit</button>
          </div>`).join("");
      periods.forEach((p) => {
        const btn = outEl.querySelector(`button[data-submit="${p.index}"]`);
        if (!btn) return;
        btn.addEventListener("click", async () => {
          if (!confirm(`Submit declaration for ${fmtDate(p.figures.periodStart)} – ${fmtDate(p.figures.periodEnd)}?`)) return;
          try {
            await api("/isopar/declarations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ periodStart: p.figures.periodStart, periodEnd: p.figures.periodEnd, notes: null }),
            });
            await loadDeclarations();
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });

      const rows = history.data || [];
      histEl.innerHTML = rows.length === 0 ? "<p>No declarations submitted yet.</p>" : `
        <table>
          <thead><tr><th>Period</th><th>Opening</th><th>Received</th><th>Closing</th><th>Consumed</th><th>Submitted By</th><th>Submitted</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${fmtDate(r.periodStart)} &ndash; ${fmtDate(r.periodEnd)}</td>
                <td>${esc(r.openingStockQty)} L</td>
                <td>${esc(r.receivedQty)} L</td>
                <td>${esc(r.closingStockQty)} L</td>
                <td>${esc(r.consumedQty)} L</td>
                <td>${esc(r.submittedByUsername)}</td>
                <td>${new Date(r.submittedAtUtc).toLocaleString("en-GB")}</td>
              </tr>`).join("")}
          </tbody>
        </table>`;
    } catch {
      // 403 (no ISOPAR_DECL) or any other failure — declarations are an
      // additive, separately-permissioned section, so just leave it hidden
      // rather than surfacing an error for users who simply lack the grant.
      document.getElementById("iso-decl-section").style.display = "none";
    }
  }

  loadReadings();
  loadStockRisk();
  loadPlanningRate();
  loadDeclarations();
})();
