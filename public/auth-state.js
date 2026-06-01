// Bridge between the MSAL login gate (auth.js) and the dashboard's api()
// helper (app.js). Keeps app.js from depending on MSAL directly.

let tokenProvider = null;
let unauthorizedHandler = null;

/** auth.js registers a function that returns a fresh ID token (or null). */
export function setTokenProvider(fn) {
  tokenProvider = fn;
}

/** app.js calls this before every request to attach the bearer token. */
export async function getAccessToken() {
  if (!tokenProvider) return null;
  try {
    return await tokenProvider();
  } catch {
    return null;
  }
}

/** auth.js registers what to do when the server rejects a request (401). */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

/** app.js calls this when a request comes back 401 mid-session. */
export function notifyUnauthorized(detail) {
  if (unauthorizedHandler) unauthorizedHandler(detail);
}
