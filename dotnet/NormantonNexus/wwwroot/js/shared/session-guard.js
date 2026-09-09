// Ported from private/js/session-guard.js (Node app) — see that file for the
// original. Behavior is unchanged; the only adaptation is the login route
// (/Login here instead of Node's /). Must load as the first <script> in
// <head>, non-deferred, non-module — see Pages/Shared/_Layout.cshtml.
(function () {
  if (window.__sessionGuardInstalled) return;
  window.__sessionGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const REDIRECT_FLAG = "sessionGuardRedirecting";

  function redirectToLogin() {
    if (sessionStorage.getItem(REDIRECT_FLAG)) return;
    sessionStorage.setItem(REDIRECT_FLAG, "1");
    window.location.href = "/Login?error=session_expired";
  }

  function isSameOriginApiCall(input) {
    let url;
    try {
      url =
        typeof input === "string" || input instanceof URL
          ? new URL(input, window.location.origin)
          : new URL(input.url, window.location.origin);
    } catch {
      return false;
    }
    return url.origin === window.location.origin;
  }

  window.fetch = async function (input, init) {
    const response = await originalFetch(input, init);

    if (!isSameOriginApiCall(input)) return response;

    // Session gone server-side — the [Authorize] policy pipeline already told us so.
    if (response.status === 401) {
      redirectToLogin();
      throw new Error("Your session has expired. Redirecting to login…");
    }

    // Guard res.json() rather than trying to pre-read the body ourselves —
    // that would consume the stream for callers that actually want
    // .blob()/.text() (file/label/export downloads), which must keep
    // working untouched.
    const originalJson = response.json.bind(response);
    response.json = async function () {
      try {
        return await originalJson();
      } catch {
        redirectToLogin();
        throw new Error("Your session has expired. Redirecting to login…");
      }
    };

    return response;
  };
})();
