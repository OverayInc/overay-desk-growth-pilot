// Microsoft (Azure AD / Entra ID) login gate — entry point for the dashboard.
//
// Flow: load /api/auth/config → if auth is disabled (dev/CI) boot the app as
// before; otherwise run MSAL against the company tenant, confirm the signed-in
// account with the server (/api/auth/me), and only then load the dashboard.
//
// The server independently re-verifies the token on every /api/* call, so this
// gate is the UX layer — the real lock is server-side.

import { setTokenProvider, setUnauthorizedHandler } from "./auth-state.js";

const APP_MODULE = "/app.js?v=20260531-auth2";

const gate = document.getElementById("authGate");
const errorEl = document.getElementById("authError");
const loginBtn = document.getElementById("authLoginBtn");
const loginLabel = document.getElementById("authLoginLabel");
const subEl = document.getElementById("authSub");
const userChip = document.getElementById("userChip");
const userEmailEl = document.getElementById("userEmail");
const logoutBtn = document.getElementById("logoutButton");

let pca = null;
let cfg = null;

function showGate() {
  if (gate) gate.hidden = false;
}
function hideGate() {
  if (gate) gate.hidden = true;
}
function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message || "";
  errorEl.hidden = !message;
}
function setBusy(busy, label) {
  if (loginBtn) loginBtn.disabled = busy;
  if (label && loginLabel) loginLabel.textContent = label;
}

async function loadConfig() {
  const res = await fetch("/api/auth/config", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("auth config load failed");
  return res.json();
}

async function getIdToken() {
  if (!pca) return null;
  const account = pca.getActiveAccount() || pca.getAllAccounts()[0];
  if (!account) return null;
  try {
    const result = await pca.acquireTokenSilent({ scopes: cfg.scopes, account });
    return result.idToken || null;
  } catch {
    return null;
  }
}

// Ask the server who we are. Returns { state: "ok"|"denied"|"anonymous", email }.
async function verifyWithServer() {
  const token = await getIdToken();
  if (!token) return { state: "anonymous" };
  const res = await fetch("/api/auth/me", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { state: "ok", email: body.email };
  }
  let code = "unauthorized";
  try {
    const body = await res.json();
    code = body?.details?.code || code;
  } catch {
    /* ignore */
  }
  return { state: code === "not_allowed" || code === "no_email" ? "denied" : "anonymous" };
}

async function bootDashboard() {
  const mod = await import(APP_MODULE);
  if (typeof mod.startDashboard === "function") mod.startDashboard();
}

async function enterApp(email) {
  setTokenProvider(getIdToken);
  setUnauthorizedHandler(() => {
    showGate();
    subEl.textContent = "세션이 만료되었습니다";
    showError("세션이 만료되었습니다. 다시 로그인해주세요.");
    setBusy(false, "Microsoft로 로그인");
  });
  if (userChip && userEmailEl && email) {
    userEmailEl.textContent = email;
    userChip.hidden = false;
  }
  hideGate();
  await bootDashboard();
}

function showDenied(email) {
  showGate();
  if (subEl) subEl.textContent = "접근 권한이 없습니다";
  showError(`${email ? `${email} — ` : ""}승인된 경영진 계정이 아닙니다. 관리자에게 문의하세요.`);
  setBusy(false, "다른 계정으로 로그인");
}

function loginErrorMessage(err) {
  const code = String(err?.errorCode || "");
  if (code.includes("user_cancelled") || code.includes("popup_window") || code.includes("cancelled")) {
    return "로그인이 취소되었습니다.";
  }
  if (code.includes("popup_blocked")) return "팝업이 차단되었습니다. 팝업 차단을 해제해주세요.";
  return "Microsoft 로그인에 실패했습니다. 다시 시도해주세요.";
}

async function doLogin() {
  showError("");
  setBusy(true, "로그인 중...");
  try {
    const result = await pca.loginPopup({ scopes: cfg.scopes, prompt: "select_account" });
    pca.setActiveAccount(result.account);
    const verdict = await verifyWithServer();
    if (verdict.state === "ok") return enterApp(verdict.email);
    if (verdict.state === "denied") return showDenied(result.account?.username);
    showError("로그인을 확인하지 못했습니다. 다시 시도해주세요.");
    setBusy(false, "Microsoft로 로그인");
  } catch (err) {
    showError(loginErrorMessage(err));
    setBusy(false, "Microsoft로 로그인");
  }
}

async function doLogout() {
  // Local sign-out only: clear THIS app's MSAL token cache so the gate returns.
  // We intentionally do NOT call logoutPopup/logoutRedirect — that would sign
  // the user out of their entire Microsoft (Azure AD) session (Teams, Office…).
  try {
    if (typeof pca.clearCache === "function") {
      await pca.clearCache();
    } else {
      // Fallback: drop only MSAL's own keys (keep app prefs like the theme).
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("msal.") || key.includes(cfg.clientId)) {
          window.localStorage.removeItem(key);
        }
      }
    }
    pca.setActiveAccount(null);
  } catch {
    /* ignore — reload still returns the gate */
  }
  window.location.reload();
}

async function main() {
  try {
    cfg = await loadConfig();
  } catch {
    showGate();
    showError("인증 설정을 불러오지 못했습니다. 새로고침 해주세요.");
    return;
  }

  // Auth not configured (local dev / CI): run open, exactly like before.
  if (!cfg.enabled) {
    setTokenProvider(async () => null);
    hideGate();
    await bootDashboard();
    return;
  }

  if (!window.msal) {
    showGate();
    showError("로그인 모듈을 불러오지 못했습니다. 새로고침 해주세요.");
    return;
  }

  pca = new window.msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
  });
  await pca.initialize();
  await pca.handleRedirectPromise().catch(() => {});

  if (loginBtn) loginBtn.addEventListener("click", doLogin);
  if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

  // Restore an existing session if there is one.
  const verdict = await verifyWithServer();
  if (verdict.state === "ok") return enterApp(verdict.email);
  if (verdict.state === "denied") return showDenied(pca.getActiveAccount()?.username);

  showGate();
  setBusy(false, "Microsoft로 로그인");
}

main();
