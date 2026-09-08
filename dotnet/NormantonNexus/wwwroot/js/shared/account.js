// "My Account" self-service — self-mounting, ported from private/js/landing.js
// + private/landing.html's account-modal markup, built on the shared
// NexusModal shell instead of Node's own bespoke account-modal-overlay.
//
// Deliberately VOLUNTARY-only, unlike Node's dual-purpose modal: this app
// already has a dedicated forced-password-change page (Pages/ChangePassword.cshtml
// + MustChangePasswordPageFilter — see that filter's own comment on why a
// real page was chosen over Node's blocking modal), so there's no "forced"
// mode, no force-notice, and no need to disable the close button here.
(function () {
  const api = window.NexusApi.make("/api/profile");

  document.addEventListener("DOMContentLoaded", () => {
    const headerRight = document.querySelector(".header-right");
    if (!headerRight) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-logout";
    btn.textContent = "My Account";
    btn.addEventListener("click", openAccountModal);

    // Before the notification bell if present, else before Sign Out, else appended.
    const bell = headerRight.querySelector("#notif-bell");
    const signOut = headerRight.querySelector('a[href="/Logout"], a[href="/logout"]');
    if (bell) headerRight.insertBefore(btn, bell);
    else if (signOut) headerRight.insertBefore(btn, signOut);
    else headerRight.appendChild(btn);
  });

  function openAccountModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div class="ps-modal-title">My Account</div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="account-section-label">Change Password</div>
        <p class="account-hint">Update the password you use to sign in. New passwords need at least 10 characters, one uppercase letter and one number.</p>
        <form id="pwd-form" class="account-form">
          <label class="account-field-label">Current Password</label>
          <input type="password" id="pwd-current" class="account-input" autocomplete="current-password" placeholder="••••••••">
          <label class="account-field-label">New Password</label>
          <input type="password" id="pwd-new" class="account-input" autocomplete="new-password" placeholder="••••••••">
          <label class="account-field-label">Confirm New Password</label>
          <input type="password" id="pwd-confirm" class="account-input" autocomplete="new-password" placeholder="••••••••">
          <div id="pwd-result" class="account-result"></div>
          <div class="account-form-actions">
            <span></span>
            <button type="submit" id="pwd-save-btn">Change Password</button>
          </div>
        </form>

        <hr style="border:none;border-top:1px solid var(--border);margin:20px 0">

        <div class="account-section-label">SAP Credentials</div>
        <p class="account-hint">Some SAP actions (like creating a purchase order) run under your own SAP login instead of the shared service account, since it isn't authorized for those transactions. Enter your SAP username and password here so those actions can run as you. Your password is encrypted and is never shown again after saving.</p>
        <div id="sap-cred-status" class="account-hint account-hint--muted">Loading…</div>
        <form id="sap-cred-form" class="account-form">
          <label class="account-field-label">SAP Username</label>
          <input type="text" id="sap-cred-username" class="account-input" autocomplete="off" placeholder="e.g. J.SMITH">
          <label class="account-field-label">SAP Password</label>
          <input type="password" id="sap-cred-password" class="account-input" autocomplete="new-password" placeholder="••••••••">
          <div id="sap-cred-result" class="account-result"></div>
          <div class="account-form-actions">
            <button type="button" id="sap-cred-clear-btn" class="secondary hidden">Clear Saved Credentials</button>
            <button type="submit" id="sap-cred-save-btn">Save</button>
          </div>
        </form>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", NexusModal.close);
    wirePasswordForm(card);
    wireSapCredentialsForm(card);
    loadSapCredStatus(card);
  }

  function wirePasswordForm(card) {
    const form = card.querySelector("#pwd-form");
    const result = card.querySelector("#pwd-result");
    const saveBtn = card.querySelector("#pwd-save-btn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const currentPassword = card.querySelector("#pwd-current").value;
      const newPassword = card.querySelector("#pwd-new").value;
      const confirmPassword = card.querySelector("#pwd-confirm").value;

      const setResult = (msg, ok) => {
        result.textContent = msg;
        result.className = "account-result " + (ok ? "account-result--ok" : "account-result--error");
      };

      if (!currentPassword || !newPassword) return setResult("Current and new password are both required.", false);
      if (newPassword !== confirmPassword) return setResult("New password and confirmation do not match.", false);
      if (newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        return setResult("New password must be at least 10 characters with one uppercase letter and one number.", false);
      }

      saveBtn.disabled = true; saveBtn.textContent = "Changing…";
      try {
        await api("/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        setResult("Password changed.", true);
        form.reset();
      } catch (err) {
        setResult(err.message, false);
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = "Change Password";
      }
    });
  }

  function wireSapCredentialsForm(card) {
    const form = card.querySelector("#sap-cred-form");
    const result = card.querySelector("#sap-cred-result");
    const saveBtn = card.querySelector("#sap-cred-save-btn");
    const clearBtn = card.querySelector("#sap-cred-clear-btn");

    const setResult = (msg, ok) => {
      result.textContent = msg;
      result.className = "account-result " + (ok ? "account-result--ok" : "account-result--error");
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const sapUsername = card.querySelector("#sap-cred-username").value.trim();
      const sapPassword = card.querySelector("#sap-cred-password").value;
      if (!sapUsername || !sapPassword) return setResult("Both SAP username and password are required.", false);

      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        await api("/sap-credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sapUsername, sapPassword }),
        });
        setResult("Saved.", true);
        await loadSapCredStatus(card);
      } catch (err) {
        setResult(err.message, false);
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = "Save";
      }
    });

    clearBtn.addEventListener("click", async () => {
      if (!(await NexusModal.confirm("Clear your saved SAP credentials? Actions that need them (like creating a purchase order) will stop working until you set them again.", { danger: true, confirmLabel: "Clear" }))) return;
      clearBtn.disabled = true;
      try {
        await api("/sap-credentials", { method: "DELETE" });
        setResult("Cleared.", true);
        await loadSapCredStatus(card);
      } catch (err) {
        setResult(err.message, false);
      } finally {
        clearBtn.disabled = false;
      }
    });
  }

  async function loadSapCredStatus(card) {
    const status = card.querySelector("#sap-cred-status");
    const usernameInput = card.querySelector("#sap-cred-username");
    const passwordInput = card.querySelector("#sap-cred-password");
    const clearBtn = card.querySelector("#sap-cred-clear-btn");
    status.textContent = "Loading…";
    try {
      const { data } = await api("/sap-credentials");
      if (data.hasCredentials) {
        const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString("en-GB") : "";
        status.textContent = `Configured — SAP username "${data.sapUsername}"${when ? ` (saved ${when})` : ""}`;
        usernameInput.value = data.sapUsername || "";
        clearBtn.classList.remove("hidden");
      } else {
        status.textContent = "Not configured yet — required for actions like creating a purchase order.";
        usernameInput.value = "";
        clearBtn.classList.add("hidden");
      }
      passwordInput.value = "";
    } catch (err) {
      status.textContent = "Failed to load status: " + err.message;
    }
  }
})();
