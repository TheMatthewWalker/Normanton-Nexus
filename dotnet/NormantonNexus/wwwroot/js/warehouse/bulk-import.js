// Bulk CSV Import tile — port of warehouse.js's CSV-parse-then-POST-/bulk
// flow, simplified to a pasted-CSV textarea instead of a file input (same
// end result: parse client-side into records, preview, submit as JSON).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const csvEl = document.getElementById("bi-csv");
  const bodyEl = document.getElementById("bi-body");
  const submitBtn = document.getElementById("bi-submit");
  let records = [];

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      const raw = {};
      headers.forEach((h, i) => { raw[h] = cols[i] ?? ""; });
      return {
        deliveryId: Number(raw.deliveryID),
        customerId: raw.customerID ? Number(raw.customerID) : null,
        dispatchDate: raw.dispatchDate || null,
        deliveryDate: null,
        deliveryService: raw.deliveryService || null,
        deliveryPriority: Number(raw.deliveryPriority) || 0,
        picksheetComment: raw.picksheetComment || null,
        incoterms: raw.incoterms || null,
      };
    });
  }

  document.getElementById("bi-preview").addEventListener("click", () => {
    records = parseCsv(csvEl.value);
    if (records.length === 0) {
      bodyEl.textContent = "No valid rows found.";
      submitBtn.style.display = "none";
      return;
    }
    bodyEl.innerHTML = `
      <p>${records.length} row(s) parsed</p>
      <table>
        <thead><tr><th>Delivery ID</th><th>Customer ID</th><th>Dispatch Date</th><th>Service</th><th>Priority</th><th>Comment</th></tr></thead>
        <tbody>
          ${records.map((r) => `<tr><td>${esc(r.deliveryId)}</td><td>${esc(r.customerId)}</td><td>${esc(r.dispatchDate)}</td><td>${esc(r.deliveryService)}</td><td>${esc(r.deliveryPriority)}</td><td>${esc(r.picksheetComment)}</td></tr>`).join("")}
        </tbody>
      </table>`;
    submitBtn.style.display = "";
  });

  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "Importing…";
    try {
      const { data } = await api("/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });
      const errLines = (data.errors || []).map((e) => `Delivery ${esc(e.deliveryId)}: ${esc(e.error)}`).join("<br>");
      bodyEl.innerHTML = `<p>Inserted: ${data.inserted}, Skipped (already existed): ${data.skipped}</p>${errLines ? `<div class="login-error">${errLines}</div>` : ""}`;
      submitBtn.style.display = "none";
    } catch (err) {
      bodyEl.innerHTML = `<p>Error: ${esc(err.message)}</p>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Import";
    }
  });
})();
