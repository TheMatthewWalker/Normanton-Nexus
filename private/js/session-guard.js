/**
 * private/js/session-guard.js
 *
 * Global safety net for the "server restarted, browser still has an old
 * session cookie" problem.
 *
 * Sessions live in Express's in-memory store (server.js — no `store:`
 * option), so a server restart (scheduled deploy, crash, manual bounce)
 * wipes every logged-in session instantly while the browser keeps holding
 * onto its now-meaningless connect.sid cookie. The next API call the user
 * makes after that either:
 *   - gets a clean 401 JSON body from requireLogin/requireRole (the happy
 *     path), which existing page code doesn't specifically handle, or
 *   - lands during the brief window the server/proxy is still coming back
 *     up and gets back an HTML/plain-text error page instead of JSON, which
 *     throws a cryptic "Unexpected token < in JSON" when the page calls
 *     res.json() — this is the "invalid json response" behaviour reported.
 *
 * Either way the user is not actually logged in any more, so instead of
 * every page having to special-case this, we patch window.fetch once,
 * globally, and:
 *   - redirect straight to the login page on any 401 response, and
 *   - redirect on any response whose body can't be parsed as JSON when the
 *     caller tries to (covers proxy error pages / mid-restart responses).
 *
 * Must load as an ordinary (non-deferred, non-module) <script> as the very
 * first tag in <head> on every private page, so the patched fetch is in
 * place before any other script (including non-deferred ones lower in the
 * page) makes its first API call.
 */
(function () {
  if (window.__sessionGuardInstalled) return;
  window.__sessionGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const REDIRECT_FLAG = 'sessionGuardRedirecting';

  function redirectToLogin() {
    if (sessionStorage.getItem(REDIRECT_FLAG)) return;
    sessionStorage.setItem(REDIRECT_FLAG, '1');
    window.location.href = '/?error=session_expired';
  }

  function isSameOriginApiCall(input) {
    let url;
    try {
      url = typeof input === 'string' || input instanceof URL
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

    // Session gone server-side — requireLogin/requireRole already told us so.
    if (response.status === 401) {
      redirectToLogin();
      throw new Error('Your session has expired. Redirecting to login…');
    }

    // Guard res.json() rather than trying to pre-read the body ourselves —
    // that would consume the stream for callers that actually want
    // .blob()/.text() (file/label/export downloads), which must keep
    // working untouched.
    const originalJson = response.json.bind(response);
    response.json = async function () {
      try {
        return await originalJson();
      } catch (err) {
        redirectToLogin();
        throw new Error('Your session has expired. Redirecting to login…');
      }
    };

    return response;
  };
})();
