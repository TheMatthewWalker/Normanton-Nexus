// Generic "click a row, edit it in a modal" helper — C# port of Node's own
// openAdminEditModal (private/js/logistics.js), used across every admin
// reference-data tile (Destinations, Forwarders, Cost Centres, GL Accounts,
// Forwarder Mode Mapping, Material Request Units, Pallet/Packaging Data)
// instead of each page hand-rolling its own modal markup.
//
// fields: [{ key, label, type, step, wide, multiline, options, checkbox }]
//   - type: "text" (default) | "number" | "date" | "select"
//   - checkbox: true renders a checkbox instead of a text/select input
//   - options: for type "select" — array of plain strings (value === label,
//     matching how these fields are actually stored, e.g. Destinations'
//     defaultForwarder holds the forwarder's name, not a foreign-key id)
// record: the current row's values, keyed the same as `fields[].key`
// onSave: async (values) => ... — should throw (with a real .message) on failure
window.AdminEditModal = (function () {
  const esc = window.NexusApi.esc;

  function open(title, subtitle, fields, record, onSave) {
    const fieldHtml = fields.map((f) => {
      const raw = record[f.key] ?? "";
      let inputEl;
      if (f.checkbox) {
        inputEl = `<input id="aed-${f.key}" type="checkbox" ${raw ? "checked" : ""} style="width:auto">`;
      } else if (f.type === "select") {
        const rawStr = String(raw ?? "");
        const opts = [...new Set(f.options || [])];
        if (rawStr && !opts.includes(rawStr)) opts.unshift(rawStr);
        const optionsHtml = ['<option value=""></option>', ...opts.map((o) =>
          `<option value="${esc(o)}" ${o === rawStr ? "selected" : ""}>${esc(o)}</option>`)].join("");
        inputEl = `<select id="aed-${f.key}" class="tf-input">${optionsHtml}</select>`;
      } else if (f.multiline) {
        inputEl = `<textarea id="aed-${f.key}" class="tf-input" rows="2" style="resize:vertical">${esc(String(raw ?? ""))}</textarea>`;
      } else {
        inputEl = `<input id="aed-${f.key}" class="tf-input" type="${f.type || "text"}" ${f.step ? `step="${f.step}"` : ""} value="${esc(String(raw ?? "")).replace(/"/g, "&quot;")}" ${f.readonly ? "readonly" : ""}>`;
      }
      return `<div class="tf-field${f.wide ? " tf-field--wide" : ""}">
        <label class="tf-label">${esc(f.label)}</label>
        ${inputEl}
      </div>`;
    }).join("");

    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${esc(title)}</div><div class="ps-modal-sub">${esc(subtitle || "")}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">${fieldHtml}</div>
        <div id="aed-result" style="margin-top:12px;font-size:13px"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="aed-cancel">Cancel</button>
        <button type="button" class="btn" id="aed-save">Save Changes</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#aed-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#aed-save").addEventListener("click", async () => {
      const btn = card.querySelector("#aed-save");
      const resultEl = card.querySelector("#aed-result");
      btn.disabled = true;
      btn.textContent = "Saving…";
      resultEl.innerHTML = "";

      const values = {};
      fields.forEach((f) => {
        const el = card.querySelector(`#aed-${f.key}`);
        if (!el) return;
        values[f.key] = f.checkbox ? el.checked : el.value.trim();
      });

      try {
        await onSave(values);
        resultEl.style.color = "var(--success)";
        resultEl.textContent = "Saved successfully.";
        btn.textContent = "Saved ✓";
        setTimeout(() => NexusModal.close(), 700);
      } catch (err) {
        resultEl.style.color = "var(--error)";
        resultEl.textContent = `✕ ${err.message}`;
        btn.disabled = false;
        btn.textContent = "Save Changes";
      }
    });

    return card;
  }

  return { open };
})();
