import { getAccessToken, notifyUnauthorized } from "./auth-state.js";

const state = {
  selectedGameId: "all",
  dashboard: null,
  games: [],
  storeListings: [],
  campaigns: [],
  creatorProfiles: [],
  creators: [],
  keys: [],
  keyPool: [],
  metrics: [],
  syncStatus: null,
  syncSchedule: null,
  settings: null,
  emailStatus: null,
  outreachLogs: [],
  readiness: null,
  youtube: null,
  redditPosts: [],
  currentEmailDraft: null,
  discovery: null,
  discoveryStatusFilter: "discovered",
  discoverySortBy: "subscribers",
};

const numberFormat = new Intl.NumberFormat("ko-KR");
const currencyFormat = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const $ = (selector) => document.querySelector(selector);

function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function number(value) {
  return numberFormat.format(Number(value || 0));
}

function money(value) {
  return currencyFormat.format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ko-KR");
}

const CREATOR_STATUS_LABELS = {
  uncontacted: "미접촉",
  sent: "발송",
  review: "리뷰",
  other: "기타",
};

const KEY_TYPE_LABELS = {
  youtuber: "유튜버",
  streamer: "스트리머",
  reviewer: "리뷰어",
  press: "매체",
  curator: "큐레이터",
  other: "기타",
};

// Real brand logos from the Simple Icons CDN (white glyph on a brand-colored badge).
const PLATFORM_SLUGS = {
  youtube: "youtube",
  tiktok: "tiktok",
  twitch: "twitch",
  steam: "steam",
  x: "x",
  instagram: "instagram",
  reddit: "reddit",
  discord: "discord",
  facebook: "facebook",
};
const WEB_GLOBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>';

function platformIcon(platform) {
  const key = String(platform || "web").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const slug = PLATFORM_SLUGS[key];
  if (slug) {
    return { key, html: `<img src="https://cdn.simpleicons.org/${slug}/white" alt="${key}" loading="lazy" />` };
  }
  return { key: "web", html: WEB_GLOBE_SVG };
}

// Stable 0-359 hue from a string, for monogram tinting.
function hueFromString(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function monogram(s) {
  const t = (s || "").trim();
  return t ? t[0].toUpperCase() : "?";
}

// Heroicons (outline) for row actions.
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.86 4.49l1.69-1.69a1.875 1.875 0 112.65 2.65l-10.6 10.6a4.5 4.5 0 01-1.9 1.13L6 18l.81-2.69a4.5 4.5 0 011.13-1.9l8.92-8.92zM19.5 7.13L16.86 4.5"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.74 9l-.35 9m-4.79 0L9.26 9M19.23 5.79a48 48 0 00-3.48-.4M4.77 5.79a48 48 0 013.48-.4m7.5 0V4.87c0-1.18-.91-2.16-2.09-2.2a51 51 0 00-3.32 0c-1.18.04-2.09 1.02-2.09 2.2v.92m7.5 0a48.67 48.67 0 00-7.5 0m9.68.95l-.66 10.1a2.25 2.25 0 01-2.25 2.1H8.7a2.25 2.25 0 01-2.25-2.1L5.79 6.74"/></svg>';

function escapeHtml(value) {
  return text(value, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function gameQuery() {
  return `gameId=${encodeURIComponent(state.selectedGameId)}`;
}

function selectedGameForForms() {
  if (state.selectedGameId !== "all") return state.selectedGameId;
  return state.games[0]?.id || "";
}

function gameName(gameId) {
  return state.games.find((game) => game.id === gameId)?.name || "Unassigned Game";
}

function gameById(gameId) {
  return state.games.find((game) => game.id === gameId);
}

function gameThumb(game, sizeClass = "") {
  const label = escapeHtml((game?.name || "게임").trim());
  if (game?.imageUrl) {
    return `<span class="game-thumb ${sizeClass}"><img src="${escapeHtml(game.imageUrl)}" alt="${label}" loading="lazy" /></span>`;
  }
  const initial = escapeHtml(((game?.name || "?").trim()[0] || "?").toUpperCase());
  return `<span class="game-thumb game-thumb--ph ${sizeClass}" aria-hidden="true">${initial}</span>`;
}

function fileToSquareDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
      img.onload = () => {
        const min = Math.min(img.width, img.height) || 1;
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setImagePreview(picker, dataUrl) {
  if (!picker) return;
  const preview = picker.querySelector("[data-image-preview]");
  const hidden = picker.querySelector('input[name="imageUrl"]');
  if (hidden) hidden.value = dataUrl || "";
  if (preview) {
    preview.classList.toggle("game-thumb--ph", !dataUrl);
    preview.innerHTML = dataUrl ? `<img src="${escapeHtml(dataUrl)}" alt="" />` : "";
  }
}

function initImagePicker(form) {
  const picker = form?.querySelector("[data-image-picker]");
  if (!picker) return;
  const input = picker.querySelector("[data-image-input]");
  picker.querySelector("[data-image-pick]")?.addEventListener("click", () => input?.click());
  picker.querySelector("[data-image-clear]")?.addEventListener("click", () => setImagePreview(picker, ""));
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      setImagePreview(picker, await fileToSquareDataUrl(file));
    } catch (error) {
      showToast(error.message || "이미지 처리에 실패했습니다.");
    }
  });
  form.addEventListener("reset", () => setImagePreview(picker, ""));
}

function platformLabel(platform) {
  const labels = {
    meta_horizon: "Meta Horizon Store",
    play: "Google Play (Galaxy XR)",
    pico: "Pico Store",
    steam: "Steam",
    itch: "itch.io",
    epic: "Epic Games Store",
    playstation: "PlayStation Store",
    quest: "Meta Quest",
    other: "Other Store",
  };
  return labels[platform] || labels.other;
}

function listingsForGame(gameId) {
  return state.storeListings.filter((listing) => listing.gameId === gameId && listing.status !== "archived");
}

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  };
  const token = await getAccessToken();
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (Object.hasOwn(options, "body")) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized(body?.details?.code);
    throw new Error(body?.error || `요청 실패: ${response.status}`);
  }
  return body;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// --- WYSIWYG rich editor (templates + mail composer) -----------------------
// Toolbar buttons drive document.execCommand on the adjacent contenteditable.
// No deps; the produced HTML is allowlist-sanitized on the server when saved/sent.
const RICH_TOOLBAR_HTML = `<div class="rich-toolbar">
  <button type="button" data-cmd="bold" title="볼드"><b>B</b></button>
  <button type="button" data-cmd="italic" title="기울임"><i>I</i></button>
  <button type="button" data-cmd="underline" title="밑줄"><span style="text-decoration:underline">U</span></button>
  <span class="rich-sep"></span>
  <button type="button" data-cmd="foreColor" data-color="#e03131" title="빨강" style="color:#e03131">A</button>
  <button type="button" data-cmd="foreColor" data-color="#1c7ed6" title="파랑" style="color:#1c7ed6">A</button>
  <button type="button" data-cmd="foreColor" data-color="#2f9e44" title="초록" style="color:#2f9e44">A</button>
  <button type="button" data-cmd="foreColor" data-color="#f08c00" title="주황" style="color:#f08c00">A</button>
  <button type="button" data-cmd="foreColor" data-color="#1a1a1a" title="기본색">A</button>
  <span class="rich-sep"></span>
  <button type="button" data-cmd="fontSize" data-size="2" title="작게" style="font-size:11px">작게</button>
  <button type="button" data-cmd="fontSize" data-size="3" title="보통">보통</button>
  <button type="button" data-cmd="fontSize" data-size="5" title="크게" style="font-size:16px">크게</button>
  <span class="rich-sep"></span>
  <button type="button" data-cmd="createLink" title="링크">🔗</button>
  <button type="button" data-cmd="insertUnorderedList" title="목록">• 목록</button>
  <button type="button" data-cmd="removeFormat" title="서식 지우기">✕</button>
</div>`;

function initRichEditors() {
  for (const field of document.querySelectorAll(".rich-field")) {
    if (!field.querySelector(".rich-toolbar")) field.insertAdjacentHTML("afterbegin", RICH_TOOLBAR_HTML);
  }
  // Don't let a toolbar click steal the editor's selection.
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest(".rich-toolbar")) e.preventDefault();
  });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".rich-toolbar button[data-cmd]");
    if (!btn) return;
    const editor = btn.closest(".rich-field")?.querySelector(".rich-editor");
    if (!editor) return;
    editor.focus();
    const cmd = btn.dataset.cmd;
    if (cmd === "foreColor") {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("foreColor", false, btn.dataset.color || "#1a1a1a");
      document.execCommand("styleWithCSS", false, false);
    } else if (cmd === "fontSize") {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("fontSize", false, btn.dataset.size || "3");
      document.execCommand("styleWithCSS", false, false);
    } else if (cmd === "createLink") {
      const url = prompt("링크 URL을 입력하세요:", "https://");
      if (url) document.execCommand("createLink", false, url.trim());
    } else if (cmd === "removeFormat") {
      document.execCommand("removeFormat");
      document.execCommand("unlink");
    } else {
      document.execCommand(cmd, false, null);
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function isHtmlContent(s) {
  return /<(?:p|br|div|span|strong|b|i|em|u|a|ul|ol|li|h[1-3]|blockquote)\b/i.test(String(s || ""));
}
function plainToHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
}
function htmlToText(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-3]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  return (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
// Set/get a rich editor's content (migrating legacy plain text to HTML on set).
function setRich(editor, content) {
  if (editor) editor.innerHTML = isHtmlContent(content) ? String(content || "") : plainToHtml(content);
}
function getRich(editor) {
  return editor ? editor.innerHTML.trim() : "";
}

function renderGameSelectors() {
  // Single-product workspace: with one product there is nothing to choose —
  // product pickers auto-select it and hide themselves.
  const singleGame = state.games.length === 1;
  const filter = $("#gameFilter");
  const current = state.selectedGameId;
  filter.innerHTML = [
    '<option value="all">전체 제품</option>',
    ...state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`),
  ].join("");
  filter.value = current === "all" || state.games.some((game) => game.id === current) ? current : "all";
  (filter.closest("label") || filter).hidden = singleGame;

  for (const select of document.querySelectorAll("[data-game-select]")) {
    // The key-pool game selector must be chosen explicitly — registering keys to
    // the wrong game is painful to undo — so it gets a blank placeholder and is
    // never auto-defaulted, unlike the other game selects. (Moot with a single
    // product: there is only one place keys can go.)
    const requireExplicit = select.id === "keyPoolGame" && !singleGame;
    const previous = requireExplicit
      ? select.value
      : state.selectedGameId === "all"
        ? select.value || selectedGameForForms()
        : selectedGameForForms();
    select.disabled = !state.games.length;
    const gameOptions = state.games.length
      ? state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")
      : '<option value="">게임을 먼저 추가</option>';
    select.innerHTML =
      requireExplicit && state.games.length ? `<option value="">— 게임을 선택하세요 —</option>${gameOptions}` : gameOptions;
    select.value = state.games.some((game) => game.id === previous) ? previous : requireExplicit ? "" : selectedGameForForms();
    if (singleGame) select.value = state.games[0].id;
    if (select.tagName === "SELECT") {
      (select.closest("label") || select).hidden = singleGame;
    }
  }

  const syncSelect = document.querySelector("#syncForm select[name='gameId']");
  if (syncSelect) {
    const previous = syncSelect.value || "all";
    syncSelect.innerHTML = [
      '<option value="all">전체 App ID 게임</option>',
      ...state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`),
    ].join("");
    syncSelect.value = previous === "all" || state.games.some((game) => game.id === previous) ? previous : "all";
  }

  const scheduleSelect = $("#scheduleGameSelect");
  if (scheduleSelect) {
    const previous = state.syncSchedule?.gameId || scheduleSelect.value || "all";
    scheduleSelect.innerHTML = [
      '<option value="all">전체 App ID 게임</option>',
      ...state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`),
    ].join("");
    scheduleSelect.value = previous === "all" || state.games.some((game) => game.id === previous) ? previous : "all";
  }

  const settingsSelect = $("#settingsGameSelect");
  if (settingsSelect) {
    const previous = settingsSelect.value || selectedGameForForms();
    settingsSelect.disabled = !state.games.length;
    settingsSelect.innerHTML = state.games.length
      ? state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")
      : '<option value="">게임을 먼저 추가</option>';
    settingsSelect.value = state.games.some((game) => game.id === previous) ? previous : selectedGameForForms();
    populateGameSettingsForm(settingsSelect.value);
  }

  const listingSelect = $("#listingGameSelect");
  if (listingSelect) {
    const previous = listingSelect.value || selectedGameForForms();
    listingSelect.disabled = !state.games.length;
    listingSelect.innerHTML = state.games.length
      ? state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")
      : '<option value="">게임을 먼저 추가</option>';
    listingSelect.value = state.games.some((game) => game.id === previous) ? previous : selectedGameForForms();
  }

  const redditSelect = $("#redditGameSelect");
  if (redditSelect) {
    const previous = redditSelect.value || "";
    redditSelect.innerHTML = [
      '<option value="">(게임 미지정)</option>',
      ...state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`),
    ].join("");
    redditSelect.value = state.games.some((game) => game.id === previous) ? previous : "";
  }

  const hasGames = state.games.length > 0;
  for (const formId of ["#campaignForm", "#csvForm", "#utmForm", "#gameSettingsForm", "#storeListingForm"]) {
    const form = $(formId);
    if (!form) continue;
    form.querySelector("button[type='submit']").disabled = !hasGames;
  }
  populateSyncScheduleForm();
}

function populateGameSettingsForm(gameId) {
  const form = $("#gameSettingsForm");
  if (!form) return;
  const game = state.games.find((item) => item.id === gameId);
  const picker = form.querySelector("[data-image-picker]");
  for (const element of form.elements) {
    if (element.name && element.name !== "gameId") element.value = "";
  }
  setImagePreview(picker, game?.imageUrl || "");
  if (!game) return;
  form.elements.name.value = game.name || "";
  if (form.elements.steamAppId) form.elements.steamAppId.value = game.steamAppId || "0";
  if (form.elements.steamStoreUrl) form.elements.steamStoreUrl.value = game.steamStoreUrl || "";
  form.elements.launchDate.value = game.launchDate || "";
  form.elements.stage.value = game.stage || "concept";
  form.elements.genre.value = game.genre || "";
  form.elements.owner.value = game.owner || "Growth";
  if (form.elements.archived) form.elements.archived.value = String(Boolean(game.archived));
}

function populateSyncScheduleForm() {
  const form = $("#syncScheduleForm");
  const schedule = state.syncSchedule;
  if (!form || !schedule) return;
  form.elements.enabled.value = String(Boolean(schedule.enabled));
  form.elements.gameId.value = schedule.gameId || "all";
  form.elements.intervalHours.value = schedule.intervalHours || 24;
  form.elements.lookbackDays.value = schedule.lookbackDays || 1;
  form.elements.startOffsetDays.value = schedule.startOffsetDays || 1;
  form.elements.includeWishlist.checked = schedule.includeWishlist !== false;
  form.elements.includeSales.checked = Boolean(schedule.includeSales);
}

function renderScope() {
  const dashboard = state.dashboard;
  const scopeBadge = $("#scopeBadge");
  if (dashboard.selectedGameId === "all") {
    scopeBadge.classList.remove("scope-badge--game");
    scopeBadge.textContent = "전체 게임";
  } else {
    scopeBadge.classList.add("scope-badge--game");
    scopeBadge.innerHTML = `${gameThumb(gameById(dashboard.selectedGameId) || { name: dashboard.selectedGameName })}<span>${escapeHtml(dashboard.selectedGameName || "전체 게임")}</span>`;
  }
  $("#scopeMeta").textContent = `캠페인 ${number(dashboard.summary.campaigns)}개 · 크리에이터 ${number(dashboard.summary.creators)}명 · 키 ${number(dashboard.summary.keys)}개`;
}

const svgIcon = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  wishlist: svgIcon('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>'),
  purchases: svgIcon('<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'),
  revenue: svgIcon('<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  trend: svgIcon('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>'),
  key: svgIcon('<circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 8.15-8.15"/><path d="m16 6 3 3"/><path d="m13 9 2 2"/>'),
  games: svgIcon('<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>'),
  subs: svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  views: svgIcon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  video: svgIcon('<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>'),
};

function renderMetricGrid(dashboard) {
  const dayLabel = dashboard.reportDate ? String(dashboard.reportDate).slice(5) : "";
  const items = [
    {
      label: "어제 위시리스트",
      value: number(dashboard.today.wishlists),
      sub: `${dayLabel} · 방문 ${number(dashboard.today.visits)}`,
      tone: "teal",
      icon: ICONS.wishlist,
    },
    {
      label: "어제 판매",
      value: number(dashboard.today.purchases),
      sub: `${dayLabel} · 위시 대비 ${dashboard.today.wishlistToPurchaseRate}%`,
      tone: "green",
      icon: ICONS.purchases,
    },
    {
      label: "어제 매출",
      value: money(dashboard.today.revenue),
      sub: `${dayLabel} · 환불 ${number(dashboard.today.refunds)}건`,
      tone: "amber",
      icon: ICONS.revenue,
    },
    {
      label: "최근 7일 위시리스트",
      value: number(dashboard.last7.wishlists),
      sub: `구매 ${number(dashboard.last7.purchases)} · 위시→구매 ${dashboard.last7.wishlistToPurchaseRate}%`,
      tone: "blue",
      icon: ICONS.trend,
    },
    {
      label: "키 배포",
      value: number(dashboard.summary.keysSent),
      sub: `누적 ${number(dashboard.summary.keys)}건`,
      tone: "teal",
      icon: ICONS.key,
    },
    {
      label: "운영 캠페인",
      value: number(dashboard.summary.campaigns),
      sub: `크리에이터 발송 누적 ${number(dashboard.summary.keysSent)}건`,
      tone: "green",
      icon: ICONS.games,
    },
  ];

  $("#metricGrid").innerHTML = items
    .map(
      (item) => `
        <article class="metric-card ${item.tone}">
          <div class="metric-head">
            <span>${item.label}</span>
            <span class="metric-icon">${item.icon}</span>
          </div>
          <strong>${item.value}</strong>
          <small>${item.sub}</small>
        </article>
      `,
    )
    .join("");
}

function niceCeil(value) {
  const v = Math.max(1, value);
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function renderTrendChart(trend) {
  const el = $("#trendChart");
  if (!el) return;
  const days = Array.isArray(trend) ? trend : [];
  const summaryEl = $("#trendSummary");
  if (days.length < 2) {
    el.innerHTML = '<div class="empty">추세를 그릴 데이터가 부족합니다. Steam 동기화로 일자별 지표를 모아주세요.</div>';
    if (summaryEl) summaryEl.textContent = "";
    return;
  }
  const W = Math.max(320, Math.round(el.clientWidth || 760));
  const H = 260;
  const padL = 46;
  const padR = 16;
  const padT = 14;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(1, ...days.map((d) => Math.max(Number(d.wishlists || 0), Number(d.purchases || 0))));
  const yMax = niceCeil(maxVal);
  const xAt = (i) => padL + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const yAt = (v) => padT + innerH - (Number(v || 0) / yMax) * innerH;
  const linePath = (key) => days.map((d, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(d[key]).toFixed(1)}`).join(" ");
  const areaPath = (key) =>
    `${linePath(key)} L${xAt(days.length - 1).toFixed(1)} ${yAt(0).toFixed(1)} L${xAt(0).toFixed(1)} ${yAt(0).toFixed(1)} Z`;

  let grid = "";
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = (yMax * s) / steps;
    const yy = yAt(v);
    grid += `<line class="tg-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"/>`;
    grid += `<text class="tg-ylabel" x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${number(Math.round(v))}</text>`;
  }
  const tickEvery = Math.max(1, Math.ceil(days.length / 6));
  let xLabels = "";
  days.forEach((d, i) => {
    if (i % tickEvery === 0 || i === days.length - 1) {
      xLabels += `<text class="tg-xlabel" x="${xAt(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${escapeHtml(String(d.date).slice(5))}</text>`;
    }
  });
  const dots = (key, cls, label) =>
    days
      .map(
        (d, i) =>
          `<circle class="tg-dot ${cls}" cx="${xAt(i).toFixed(1)}" cy="${yAt(d[key]).toFixed(1)}" r="2.4"><title>${escapeHtml(d.date)} · ${label} ${number(d[key])}</title></circle>`,
      )
      .join("");

  el.innerHTML = `
    <svg class="trend-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="위시리스트 판매 추세">
      ${grid}
      <path class="tg-area tg-area-wish" d="${areaPath("wishlists")}"/>
      <path class="tg-line tg-line-wish" d="${linePath("wishlists")}"/>
      <path class="tg-line tg-line-buy" d="${linePath("purchases")}"/>
      ${dots("wishlists", "tg-dot-wish", "위시")}
      ${dots("purchases", "tg-dot-buy", "판매")}
      ${xLabels}
    </svg>`;

  if (summaryEl) {
    const totW = days.reduce((sum, d) => sum + Number(d.wishlists || 0), 0);
    const totP = days.reduce((sum, d) => sum + Number(d.purchases || 0), 0);
    const totR = days.reduce((sum, d) => sum + Number(d.revenue || 0), 0);
    summaryEl.textContent = `최근 ${days.length}일 · 위시 ${number(totW)} · 판매 ${number(totP)} · 매출 ${money(totR)}`;
  }
}

function renderConversionFunnel(funnel) {
  const el = $("#conversionFunnel");
  if (!el) return;
  if (!funnel || (!funnel.wishlists && !funnel.purchases && !funnel.visits)) {
    el.innerHTML = '<div class="empty">전환을 계산할 Steam 지표가 없습니다.</div>';
    return;
  }
  const stages = [];
  if (funnel.hasVisits) stages.push({ label: "방문", value: funnel.visits, note: "" });
  stages.push({
    label: "위시리스트",
    value: funnel.wishlists,
    note: funnel.hasVisits ? `방문→위시 ${funnel.visitToWishlist}%` : "",
  });
  stages.push({
    label: "구매",
    value: funnel.purchases,
    note: `위시→구매 ${funnel.wishlistToPurchase}%${funnel.hasVisits ? ` · 방문→구매 ${funnel.visitToPurchase}%` : ""}`,
  });
  const max = Math.max(...stages.map((s) => Number(s.value || 0)), 1);
  el.innerHTML =
    stages
      .map(
        (s) => `
        <div class="funnel-row">
          <div class="funnel-label">${s.label}</div>
          <div class="funnel-bar"><div class="funnel-fill" style="width:${Math.max(3, Math.round((Number(s.value || 0) / max) * 100))}%"></div></div>
          <div class="funnel-meta"><strong>${number(s.value)}</strong>${s.note ? `<span>${escapeHtml(s.note)}</span>` : ""}</div>
        </div>
      `,
      )
      .join("") +
    (funnel.hasVisits
      ? ""
      : '<div class="funnel-note">방문(상점 페이지 노출) 수는 Steam 위시리스트/재무 API에 없습니다. Steamworks 트래픽 CSV를 가져오면 "방문 → 위시" 전환율까지 표시됩니다.</div>');
}

function renderPlatformChips(listings) {
  if (!listings.length) return '<span class="cell-sub">리스팅 없음</span>';
  return `
    <div class="platform-row">
      ${listings
        .map((listing) => `<span class="platform-chip ${escapeHtml(listing.platform)}">${escapeHtml(listing.platformLabel || platformLabel(listing.platform))}</span>`)
        .join("")}
    </div>
  `;
}

// Single-product workspace: the admin screen is centered on the store listings;
// the product itself is edited via the always-visible product form.
function renderGameAdmin() {
  const product = state.games.find((game) => !game.archived) || state.games[0];
  const activeListings = state.storeListings.filter((listing) => listing.status !== "archived");
  $("#gameAdminSummary").textContent = `${product ? product.name : "제품 없음"} · 스토어 리스팅 ${number(activeListings.length)}개`;

  if (!activeListings.length) {
    $("#storeListingTable").innerHTML = '<tr><td data-label="상태" colspan="6"><span class="empty">연결된 스토어 리스팅이 없습니다.</span></td></tr>';
    return;
  }

  $("#storeListingTable").innerHTML = activeListings
    .map(
      (listing) => `
        <tr>
          <td data-label="스토어"><span class="platform-chip ${escapeHtml(listing.platform)}">${escapeHtml(listing.platformLabel || platformLabel(listing.platform))}</span></td>
          <td data-label="ID / Slug">${escapeHtml(listing.externalId || "-")}</td>
          <td data-label="상태"><span class="status ${escapeHtml(listing.status || "draft")}">${escapeHtml(listing.status || "draft")}</span></td>
          <td data-label="Store URL" class="link-cell">${
            listing.storeUrl ? `<a href="${escapeHtml(listing.storeUrl)}" target="_blank" rel="noreferrer">열기</a>` : "-"
          }</td>
          <td data-label="Dashboard" class="link-cell">${
            listing.dashboardUrl ? `<a href="${escapeHtml(listing.dashboardUrl)}" target="_blank" rel="noreferrer">열기</a>` : "-"
          }</td>
          <td data-label="작업">
            <button class="table-button secondary-button danger-button" type="button" data-archive-listing-id="${escapeHtml(listing.id)}"${
              listing.platform === "steam" ? ' data-listing-steam="1"' : ""
            }>삭제</button>
          </td>
        </tr>
      `,
    )
    .join("");
}

function renderReadiness() {
  const readiness = state.readiness;
  if (!readiness) return;
  $("#readinessSummary").textContent = `준비 완료 ${number(readiness.summary.readyGames)} / 전체 ${number(readiness.summary.games)}`;
  if (!readiness.games.length) {
    $("#readinessGrid").innerHTML = `
      <div class="empty-state">
        <strong>연동 준비를 확인할 게임이 없습니다.</strong>
        <span>게임을 추가하면 App ID, Store URL, API Key, 캠페인, 지표 상태를 체크합니다.</span>
      </div>
    `;
    return;
  }
  $("#readinessGrid").innerHTML = readiness.games
    .map(
      (game) => `
        <article class="readiness-card">
          <header>
            <div class="cell-with-thumb">
              ${gameThumb(gameById(game.gameId) || { name: game.gameName }, "game-thumb--md")}
              <div>
                <h3>${escapeHtml(game.gameName)}</h3>
                <span class="cell-sub">${escapeHtml((game.platforms || []).map((platform) => platform.label).join(", ") || "No store")} / ${escapeHtml(game.status)}</span>
              </div>
            </div>
            <div class="readiness-score" style="--p: ${Math.max(0, Math.min(100, Number(game.score) || 0))}%" data-score="${number(game.score)}%"></div>
          </header>
          <div class="check-grid">
            ${game.checks
              .map((check) =>
                check.applicable === false
                  ? `<span class="check-chip na">해당 없음 ${escapeHtml(check.label)}</span>`
                  : `<span class="check-chip ${check.ok ? "ok" : ""}">${check.ok ? "OK" : "Need"} ${escapeHtml(check.label)}</span>`,
              )
              .join("")}
          </div>
          <div class="cell-sub">
            캠페인 ${number(game.counts.campaigns)}개 · 크리에이터 ${number(game.counts.creators)}명 · 지표 ${number(game.counts.metrics)}건
          </div>
        </article>
      `,
    )
    .join("");
}

function youtubeSubDelta(channelId) {
  const snaps = (state.youtube?.snapshots || [])
    .filter((snap) => snap.channelId === channelId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (snaps.length < 2) return null;
  const latest = snaps[snaps.length - 1];
  const prev = snaps[snaps.length - 2];
  return { subs: latest.subscribers - prev.subscribers, views: latest.views - prev.views, since: prev.date };
}

function signedNumber(value) {
  const n = Number(value || 0);
  return `${n > 0 ? "+" : ""}${number(n)}`;
}

function renderYoutubeMetrics(channel) {
  const grid = $("#youtubeMetricGrid");
  if (!grid) return;
  if (!channel) {
    grid.innerHTML = "";
    return;
  }
  const delta = youtubeSubDelta(channel.channelId);
  const videos = channel.recentVideos || [];
  const avgViews = videos.length
    ? Math.round(videos.reduce((sum, video) => sum + Number(video.views || 0), 0) / videos.length)
    : 0;
  const items = [
    {
      label: "구독자",
      value: channel.hiddenSubscriberCount ? "비공개" : number(channel.subscribers),
      sub: delta ? `직전 대비 ${signedNumber(delta.subs)}` : channel.lastSyncedAt ? "최신 동기화 기준" : "동기화 필요",
      tone: "teal",
      icon: ICONS.subs,
    },
    {
      label: "총 조회수",
      value: number(channel.views),
      sub: delta ? `직전 대비 ${signedNumber(delta.views)}` : "누적",
      tone: "blue",
      icon: ICONS.views,
    },
    {
      label: "영상 수",
      value: number(channel.videoCount),
      sub: `최근 ${number(videos.length)}개 표시`,
      tone: "green",
      icon: ICONS.video,
    },
    {
      label: "최근 영상 평균 조회",
      value: number(avgViews),
      sub: videos.length ? `최근 ${number(videos.length)}개 기준` : "영상 없음",
      tone: "amber",
      icon: ICONS.trend,
    },
  ];
  grid.innerHTML = items
    .map(
      (item) => `
        <article class="metric-card ${item.tone}">
          <div class="metric-head"><span>${item.label}</span><span class="metric-icon">${item.icon}</span></div>
          <strong>${item.value}</strong>
          <small>${item.sub}</small>
        </article>
      `,
    )
    .join("");
}

function renderYoutubeVideos(channel) {
  const videos = channel?.recentVideos || [];
  $("#youtubeVideoCount").textContent = channel
    ? channel.lastSyncedAt
      ? `최근 동기화 ${new Date(channel.lastSyncedAt).toLocaleString("ko-KR")}`
      : "동기화 필요"
    : "-";
  if (!videos.length) {
    $("#youtubeVideoTable").innerHTML = `<tr><td data-label="상태" colspan="5"><span class="empty">${
      channel ? '영상 데이터가 없습니다. "지금 동기화"를 눌러주세요.' : "채널을 추가하세요."
    }</span></td></tr>`;
    return;
  }
  $("#youtubeVideoTable").innerHTML = videos
    .map(
      (video) => `
        <tr>
          <td data-label="영상">
            <div class="cell-with-thumb">
              <span class="game-thumb game-thumb--sm">${
                video.thumbnail ? `<img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" />` : ""
              }</span>
              <div>
                <span class="cell-title">${escapeHtml(video.title)}</span>
                <span class="cell-sub link-cell"><a href="https://youtu.be/${escapeHtml(video.id)}" target="_blank" rel="noreferrer">영상 열기</a></span>
              </div>
            </div>
          </td>
          <td data-label="게시일">${escapeHtml((video.publishedAt || "").slice(0, 10) || "-")}</td>
          <td data-label="조회수" class="num">${number(video.views)}</td>
          <td data-label="좋아요" class="num">${number(video.likes)}</td>
          <td data-label="댓글" class="num">${number(video.comments)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderYtSeriesChart(el, points, variant) {
  if (!el) return;
  if (points.length < 2) {
    el.innerHTML = '<div class="empty">2일 이상 동기화되면 추이가 표시됩니다.</div>';
    return;
  }
  const W = Math.max(280, Math.round(el.clientWidth || 480));
  const H = 180;
  const padL = 50;
  const padR = 14;
  const padT = 12;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const values = points.map((p) => Number(p.value || 0));
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const lo = minV === maxV ? Math.max(0, minV - 1) : minV - (maxV - minV) * 0.12;
  const hi = minV === maxV ? minV + 1 : maxV + (maxV - minV) * 0.12;
  const span = hi - lo || 1;
  const xAt = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yAt = (v) => padT + innerH - ((Number(v || 0) - lo) / span) * innerH;
  const linePath = points.map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(1)} ${yAt(lo).toFixed(1)} L${xAt(0).toFixed(1)} ${yAt(lo).toFixed(1)} Z`;
  let grid = "";
  for (let s = 0; s <= 2; s++) {
    const v = lo + (span * s) / 2;
    const yy = yAt(v);
    grid += `<line class="tg-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"/>`;
    grid += `<text class="tg-ylabel" x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${number(Math.round(v))}</text>`;
  }
  const tickEvery = Math.max(1, Math.ceil(points.length / 5));
  let xLabels = "";
  points.forEach((p, i) => {
    if (i % tickEvery === 0 || i === points.length - 1) {
      xLabels += `<text class="tg-xlabel" x="${xAt(i).toFixed(1)}" y="${H - 9}" text-anchor="middle">${escapeHtml(String(p.date).slice(5))}</text>`;
    }
  });
  const dots = points
    .map(
      (p, i) =>
        `<circle class="tg-dot tg-dot-${variant}" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="2.4"><title>${escapeHtml(p.date)} · ${number(p.value)}</title></circle>`,
    )
    .join("");
  el.innerHTML = `
    <svg class="trend-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
      ${grid}
      <path class="tg-area tg-area-${variant}" d="${areaPath}"/>
      <path class="tg-line tg-line-${variant}" d="${linePath}"/>
      ${dots}
      ${xLabels}
    </svg>`;
}

function renderYoutubeCharts(channel) {
  const subsEl = $("#youtubeSubsChart");
  const viewsEl = $("#youtubeViewsChart");
  if (!subsEl || !viewsEl) return;
  const yt = state.youtube || {};
  const snaps = channel
    ? (yt.snapshots || [])
        .filter((snap) => snap.channelId === channel.channelId)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    : [];
  renderYtSeriesChart(subsEl, snaps.map((s) => ({ date: s.date, value: Number(s.subscribers || 0) })), "subs");
  renderYtSeriesChart(viewsEl, snaps.map((s) => ({ date: s.date, value: Number(s.views || 0) })), "views");
  const last = snaps[snaps.length - 1];
  $("#youtubeSubsLabel").textContent = last ? `현재 ${number(last.subscribers)}` : "데이터 없음";
  $("#youtubeViewsLabel").textContent = last ? `현재 ${number(last.views)}` : "데이터 없음";
}

function renderYoutube() {
  const yt = state.youtube;
  if (!yt) return;
  const statusEl = $("#youtubeStatus");
  if (statusEl) {
    statusEl.textContent = yt.configured
      ? `API 연결됨 · 채널 ${number(yt.channels.length)}개${yt.channels.length ? " · 자동 기록 ON(1일 1회)" : ""}`
      : "API 키 미설정";
  }
  const configPanel = $("#youtubeConfigPanel");
  if (configPanel && !yt.configured && !configPanel.dataset.touched) configPanel.setAttribute("open", "");

  if (!yt.selectedChannelId || !yt.channels.some((channel) => channel.id === yt.selectedChannelId)) {
    yt.selectedChannelId = yt.channels[0]?.id || null;
  }

  $("#youtubeChannelTabs").innerHTML = yt.channels.length
    ? yt.channels
        .map(
          (channel) => `
            <button class="yt-tab ${channel.id === yt.selectedChannelId ? "active" : ""}" type="button" data-yt-channel="${escapeHtml(channel.id)}">
              ${channel.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" />` : ""}
              <span>${escapeHtml(channel.title || channel.channelId)}</span>
              <span class="yt-tab__del" data-yt-del="${escapeHtml(channel.id)}" role="button" aria-label="채널 삭제" title="삭제">×</span>
            </button>
          `,
        )
        .join("")
    : '<div class="empty">등록된 채널이 없습니다. 위 "YouTube 연동 설정"에서 채널을 추가하세요.</div>';

  const channel = yt.channels.find((item) => item.id === yt.selectedChannelId);
  renderYoutubeMetrics(channel);
  renderYoutubeVideos(channel);
  renderYoutubeCharts(channel);

  const oauthForm = $("#youtubeOAuthForm");
  if (oauthForm && document.activeElement !== oauthForm.elements.youtubeClientId) {
    oauthForm.elements.youtubeClientId.value = yt.oauth?.clientId || "";
  }
  renderYoutubeOAuth(yt);
  renderYoutubeAnalytics();
  maybeLoadYoutubeAnalytics();
}

function renderYoutubeOAuth(yt) {
  const el = $("#youtubeOAuthStatus");
  if (!el) return;
  const oauth = yt.oauth || {};
  el.innerHTML = `
    <div class="settings-meta">리디렉션 URI (Google 콘솔에 그대로 등록): <code>${escapeHtml(oauth.redirectUri || "")}</code></div>
    <div class="button-row" style="margin-top: 10px;">
      ${
        oauth.connected
          ? `<span class="status-pill ok">Google 연결됨${oauth.connectedAt ? ` · ${new Date(oauth.connectedAt).toLocaleDateString("ko-KR")}` : ""}</span>
             <button class="secondary-button danger-button" type="button" id="youtubeDisconnectButton">연결 해제</button>`
          : `<button type="button" id="youtubeConnectButton"${oauth.clientConfigured ? "" : " disabled"}>Google 계정 연결</button>
             ${oauth.clientConfigured ? "" : '<span class="muted">먼저 Client ID/Secret을 저장하세요</span>'}`
      }
    </div>`;
}

function maybeLoadYoutubeAnalytics() {
  const yt = state.youtube;
  if (!yt || !yt.oauth?.connected || yt.analyticsLoading) return;
  const channel = yt.channels.find((item) => item.id === yt.selectedChannelId);
  if (!channel) return;
  const key = `${channel.id}:${yt.selectedDays}`;
  if (yt.analyticsKey === key) return;
  loadYoutubeAnalytics(channel, yt.selectedDays, key);
}

async function loadYoutubeAnalytics(channel, days, key) {
  const yt = state.youtube;
  yt.analyticsLoading = true;
  yt.analyticsError = "";
  renderYoutubeAnalytics();
  try {
    const result = await api(`/api/youtube/analytics?channelId=${encodeURIComponent(channel.id)}&days=${days}`);
    yt.analytics = result;
    yt.analyticsKey = key;
  } catch (error) {
    yt.analytics = null;
    yt.analyticsKey = key;
    yt.analyticsError = error.message;
  } finally {
    yt.analyticsLoading = false;
    renderYoutubeAnalytics();
  }
}

const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(["ko"], { type: "region" });
  } catch {
    return null;
  }
})();
function regionName(code) {
  if (!code || code === "ZZ") return "기타/미상";
  try {
    return REGION_NAMES?.of(code) || code;
  } catch {
    return code;
  }
}
const TRAFFIC_LABELS = {
  YT_SEARCH: "YouTube 검색",
  SUGGESTED_VIDEO: "추천 영상",
  RELATED_VIDEO: "관련 영상",
  BROWSE: "탐색(홈/구독)",
  CHANNEL: "채널 페이지",
  PLAYLIST: "재생목록",
  YT_PLAYLIST_PAGE: "재생목록 페이지",
  EXT_URL: "외부 링크",
  NOTIFICATION: "알림",
  SHORTS: "Shorts 피드",
  SUBSCRIBER: "구독 피드",
  NO_LINK_OTHER: "기타",
  NO_LINK_EMBEDDED: "임베드 재생",
  ADVERTISING: "광고",
  END_SCREEN: "최종 화면",
  ANNOTATION: "카드/주석",
  HASHTAGS: "해시태그",
};
function trafficLabel(code) {
  return TRAFFIC_LABELS[code] || code || "기타";
}
function formatWatchMinutes(min) {
  const m = Math.round(Number(min || 0));
  if (m < 60) return `${number(m)}분`;
  return `${number(Math.floor(m / 60))}시간 ${m % 60}분`;
}
function formatSeconds(sec) {
  const s = Math.round(Number(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderYoutubeAnalytics() {
  const container = $("#youtubeAnalytics");
  if (!container) return;
  const yt = state.youtube;
  if (!yt) {
    container.innerHTML = "";
    return;
  }
  const oauth = yt.oauth || {};
  if (!oauth.connected) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>비공개 분석은 Google 연결이 필요합니다.</strong>
        <span>위 "YouTube 연동 설정"에서 OAuth Client를 저장하고 Google 계정을 연결하면 조회수·시청시간·국가별·유입경로 분석을 볼 수 있습니다.</span>
      </div>`;
    return;
  }
  const channel = yt.channels.find((item) => item.id === yt.selectedChannelId);
  if (!channel) {
    container.innerHTML = "";
    return;
  }

  const rangeButtons = [7, 28, 90]
    .map((d) => `<button class="yt-range ${yt.selectedDays === d ? "active" : ""}" type="button" data-yt-days="${d}">${d}일</button>`)
    .join("");
  const head = `
    <div class="yt-analytics-head">
      <h3>Analytics · ${escapeHtml(channel.title || channel.channelId)}</h3>
      <div class="yt-range-group">${rangeButtons}<button class="secondary-button table-button" type="button" data-yt-refresh>새로고침</button></div>
    </div>`;

  if (yt.analyticsLoading && !yt.analytics) {
    container.innerHTML = `${head}<div class="empty">분석 데이터를 불러오는 중…</div>`;
    return;
  }
  if (yt.analyticsError) {
    container.innerHTML = `${head}<div class="empty">분석을 불러오지 못했습니다: ${escapeHtml(yt.analyticsError)}</div>`;
    return;
  }
  const a = yt.analytics;
  if (!a) {
    container.innerHTML = `${head}<div class="empty">분석 데이터가 없습니다.</div>`;
    return;
  }

  const t = a.totals;
  const cards = [
    { label: `조회수 (최근 ${a.days}일)`, value: number(t.views), sub: `${a.range.startDate} ~ ${a.range.endDate}`, tone: "blue", icon: ICONS.views },
    { label: "시청시간", value: formatWatchMinutes(t.minutes), sub: "추정 시청시간", tone: "teal", icon: ICONS.video },
    { label: "평균 시청 지속", value: formatSeconds(t.avgViewDuration), sub: "분:초", tone: "amber", icon: ICONS.trend },
    { label: "순구독", value: signedNumber(t.netSubs), sub: `+${number(t.gained)} / -${number(t.lost)}`, tone: "green", icon: ICONS.subs },
  ];
  const cardsHtml = `<div class="metric-grid">${cards
    .map(
      (c) => `<article class="metric-card ${c.tone}"><div class="metric-head"><span>${c.label}</span><span class="metric-icon">${c.icon}</span></div><strong>${c.value}</strong><small>${escapeHtml(c.sub)}</small></article>`,
    )
    .join("")}</div>`;

  const maxViews = Math.max(...a.daily.map((d) => Number(d.views || 0)), 1);
  const sparkHtml = `
    <div class="panel">
      <div class="panel-title"><h3>일별 조회수</h3><span>${a.range.startDate} ~ ${a.range.endDate}</span></div>
      <div class="yt-spark">${a.daily
        .map(
          (d) =>
            `<span class="yt-spark-bar" style="height:${Math.max(2, Math.round((Number(d.views || 0) / maxViews) * 100))}%" title="${escapeHtml(d.day)} · ${number(d.views)} views · ${formatWatchMinutes(d.estimatedMinutesWatched)}"></span>`,
        )
        .join("")}</div>
    </div>`;

  const maxCountry = Math.max(...a.countries.map((c) => Number(c.views || 0)), 1);
  const countriesHtml = `
    <div class="panel">
      <div class="panel-title"><h3>국가별 시청자 Top</h3><span>조회수 기준</span></div>
      <div class="bar-list">${
        a.countries.length
          ? a.countries
              .map(
                (c) =>
                  `<div class="bar-item"><div class="bar-label">${escapeHtml(regionName(c.country))}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Math.round((Number(c.views || 0) / maxCountry) * 100))}%"></div></div><div class="bar-meta">${number(c.views)} · ${formatWatchMinutes(c.estimatedMinutesWatched)}</div></div>`,
              )
              .join("")
          : '<div class="empty">데이터 없음</div>'
      }</div>
    </div>`;

  const maxTraffic = Math.max(...a.trafficSources.map((s) => Number(s.views || 0)), 1);
  const trafficHtml = `
    <div class="panel">
      <div class="panel-title"><h3>유입경로</h3><span>조회수 기준</span></div>
      <div class="bar-list">${
        a.trafficSources.length
          ? a.trafficSources
              .map(
                (s) =>
                  `<div class="bar-item"><div class="bar-label">${escapeHtml(trafficLabel(s.insightTrafficSourceType))}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Math.round((Number(s.views || 0) / maxTraffic) * 100))}%"></div></div><div class="bar-meta">${number(s.views)}</div></div>`,
              )
              .join("")
          : '<div class="empty">데이터 없음</div>'
      }</div>
    </div>`;

  const videosHtml = `
    <div class="panel">
      <div class="panel-title"><h3>영상별 성과</h3><span>조회수 Top ${number(a.topVideos.length)}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>영상</th><th class="num">조회수</th><th class="num">시청시간</th><th class="num">평균 시청률</th></tr></thead>
          <tbody>${
            a.topVideos.length
              ? a.topVideos
                  .map(
                    (v) =>
                      `<tr><td data-label="영상"><span class="cell-title"><a href="https://youtu.be/${escapeHtml(v.video)}" target="_blank" rel="noreferrer">${escapeHtml(v.title || v.video)}</a></span></td><td data-label="조회수" class="num">${number(v.views)}</td><td data-label="시청시간" class="num">${formatWatchMinutes(v.estimatedMinutesWatched)}</td><td data-label="평균 시청률" class="num">${Number(v.averageViewPercentage || 0).toFixed(1)}%</td></tr>`,
                  )
                  .join("")
              : '<tr><td data-label="상태" colspan="4"><span class="empty">데이터 없음</span></td></tr>'
          }</tbody>
        </table>
      </div>
    </div>`;

  container.innerHTML = `${head}${cardsHtml}${sparkHtml}<div class="insight-grid">${countriesHtml}${trafficHtml}</div>${videosHtml}`;
}

// Show who the saved Reddit session belongs to (and, when missing, WHERE the
// server looked — the usual headless-deploy gotcha). Click to re-verify live.
async function loadRedditSessionInfo({ refresh = false } = {}) {
  const el = $("#redditSessionInfo");
  if (!el) return;
  if (refresh) el.textContent = "계정 확인 중…";
  let s;
  try {
    s = await api(`/api/reddit/session${refresh ? "?refresh=1" : ""}`);
  } catch {
    el.innerHTML = '<span class="reddit-session-dot off"></span>세션 상태를 불러오지 못했습니다.';
    return;
  }
  if (!s.present) {
    el.innerHTML =
      '<span class="reddit-session-dot off"></span>로그인 세션 없음 — ' +
      `<code>${escapeHtml(s.path || "data/reddit-state.json")}</code> 에 세션 파일이 없습니다. ` +
      "데스크톱에서 만들어 커밋/배포하세요.";
    el.title = "이 서버는 headless라 여기서 직접 로그인할 수 없습니다. 세션 파일을 이 경로에 두세요.";
    return;
  }
  const who = s.username
    ? `<strong>u/${escapeHtml(s.username)}</strong>${s.email ? ` · ${escapeHtml(s.email)}` : ""}`
    : '계정 미확인 <span class="link-look">(클릭해 확인)</span>';
  const when = s.capturedAt ? ` · ${new Date(s.capturedAt).toLocaleDateString("ko-KR")} 저장` : "";
  el.innerHTML = `<span class="reddit-session-dot on"></span>로그인: ${who}${when}`;
  el.title = `쿠키 ${s.cookieCount}개${s.loginTime ? ` · 로그인 ${s.loginTime}` : ""} · 클릭하면 계정을 다시 확인합니다`;
}

// Start a slow Reddit background job (import-mine / refresh) and poll it to
// completion. The slow scrape runs server-side, so each request here is quick —
// this is what avoids the reverse-proxy upstream timeout (503) on long actions.
async function runRedditJob({ startPath, body, btn, busyText, useGameScope = false }) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await api(startPath, { method: "POST", body });
    let job = null;
    for (let i = 0; i < 200; i++) {
      await sleep(3000);
      job = await api("/api/reddit-posts/job");
      if (!job.running) break;
      if (job.message) btn.textContent = job.message.length > 28 ? busyText : job.message;
    }
    if (job?.error) {
      showToast(job.error);
    } else {
      showToast(job?.message || "완료했습니다.");
      await loadAll();
      loadRedditSessionInfo();
    }
  } catch (error) {
    showToast(error.message || "작업에 실패했습니다.");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderRedditPosts() {
  if (!$("#redditTable")) return;
  $("#redditCount").textContent = `글 ${number(state.redditPosts.length)}개`;
  if (!state.redditPosts.length) {
    $("#redditTable").innerHTML = '<tr><td data-label="상태" colspan="8"><span class="empty">기록된 레딧 글이 없습니다.</span></td></tr>';
    return;
  }
  $("#redditTable").innerHTML = state.redditPosts
    .map((post) => {
      const ratio = post.upvoteRatio ? ` · ${Math.round(post.upvoteRatio * 100)}%` : "";
      const titleText = post.title || post.postId || "(제목 없음)";
      const titleCell = post.url
        ? `<a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(titleText)}</a>`
        : escapeHtml(titleText);
      return `
        <tr>
          <td data-label="글"><span class="cell-title">${titleCell}</span><span class="cell-sub">${escapeHtml(post.subreddit || "-")}${ratio}</span></td>
          <td data-label="게임">${escapeHtml(post.gameName || "-")}</td>
          <td data-label="상태"><span class="status ${escapeHtml(post.status)}">${escapeHtml(post.status)}</span></td>
          <td data-label="조회수" class="num">${post.views ? number(post.views) : "-"}</td>
          <td data-label="업보트" class="num">${number(post.upvotes)}</td>
          <td data-label="댓글" class="num">${number(post.comments)}</td>
          <td data-label="게시일">${escapeHtml(post.postedAt || "-")}</td>
          <td data-label="작업"><button class="table-button secondary-button danger-button" type="button" data-del-reddit="${escapeHtml(post.id)}">삭제</button></td>
        </tr>
      `;
    })
    .join("");
}

function renderCampaignBars(campaigns) {
  if (!campaigns.length) {
    $("#campaignBars").innerHTML = '<div class="empty">캠페인 지표가 없습니다.</div>';
    return;
  }
  const maxWishlist = Math.max(...campaigns.map((campaign) => campaign.wishlists), 1);
  $("#campaignBars").innerHTML = campaigns
    .map((campaign) => {
      const width = Math.max(6, Math.round((campaign.wishlists / maxWishlist) * 100));
      const label =
        state.selectedGameId === "all" ? `${campaign.gameName} / ${campaign.campaignName}` : campaign.campaignName;
      return `
        <div class="bar-item">
          <div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-meta">위시 ${number(campaign.wishlists)} · 구매 ${number(campaign.purchases)}</div>
        </div>
      `;
    })
    .join("");
}

function renderContactQueue(creators) {
  if (!creators.length) {
    $("#contactQueue").innerHTML = '<div class="empty">연락 대기 항목이 없습니다.</div>';
    return;
  }
  $("#contactQueue").innerHTML = creators
    .map(
      (creator) => `
        <div class="queue-item">
          <div>
            <div class="queue-name">${escapeHtml(creator.channelName)}</div>
            <div class="tag-row">
              <span class="tag">${escapeHtml(gameName(creator.gameId))}</span>
              ${(creator.tags || []).slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
          </div>
          <div class="queue-meta">${number(creator.fitScore)} / ${escapeHtml(creator.status)}</div>
        </div>
      `,
    )
    .join("");
}

function renderDashboard() {
  const dashboard = state.dashboard;
  const dateLabel = state.metrics.length ? dashboard.latestDate : "지표 없음";
  $("#latestDate").textContent = `기준일 ${dateLabel} / ${dashboard.selectedGameName}`;
  renderScope();
  renderMetricGrid(dashboard);
  renderTrendChart(dashboard.trend);
  renderConversionFunnel(dashboard.funnel);
  renderCampaignBars(dashboard.topCampaigns);
  renderContactQueue(dashboard.contactQueue);
}

function renderCampaigns() {
  $("#campaignCount").textContent = `캠페인 ${number(state.campaigns.length)}개`;
  if (!state.campaigns.length) {
    $("#campaignTable").innerHTML = '<tr><td data-label="상태" colspan="9"><span class="empty">캠페인이 없습니다.</span></td></tr>';
    return;
  }
  $("#campaignTable").innerHTML = state.campaigns
    .map(
      (campaign) => `
        <tr>
          <td data-label="캠페인"><span class="cell-title">${escapeHtml(campaign.name)}</span><span class="cell-sub">${escapeHtml(campaign.goal || campaign.id)}</span></td>
          <td data-label="게임">${escapeHtml(campaign.gameName || gameName(campaign.gameId))}</td>
          <td data-label="채널">${escapeHtml((campaign.channels || []).join(", "))}</td>
          <td data-label="이메일" class="num">${number(campaign.sentEmails)} / ${number(campaign.replies)}</td>
          <td data-label="키" class="num">${number(campaign.keysSent)}</td>
          <td data-label="방문" class="num">${number(campaign.metrics?.visits)}</td>
          <td data-label="위시리스트" class="num">${number(campaign.metrics?.wishlists)}<span class="cell-sub">${number(campaign.metrics?.wishlistRate)}%</span></td>
          <td data-label="구매" class="num">${number(campaign.metrics?.purchases)}<span class="cell-sub">${number(campaign.metrics?.purchaseRate)}%</span></td>
          <td data-label="매출" class="num">${money(campaign.metrics?.revenue)}</td>
        </tr>
      `,
    )
    .join("");
}

// Channel-link icon badges for a profile (reused in the matrix name column).
function channelIconsHtml(profile) {
  if (!(profile.channels || []).length) return "";
  return profile.channels
    .map((ch) => {
      const icon = platformIcon(ch.platform);
      return `<a class="channel-icon plat-${icon.key}" href="${escapeHtml(ch.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(ch.platform)} · ${escapeHtml(ch.url)}" aria-label="${escapeHtml(ch.platform)}">${icon.html}</a>`;
    })
    .join("");
}

function activationCell(record) {
  const activation = record.steamActivation;
  if (!activation) return '<span class="status reserved">미확인</span>';
  const when = activation.checkedAt ? `확인 ${formatDateTime(activation.checkedAt)}` : "";
  const manual = activation.source === "manual" ? " (수동)" : "";
  if (activation.activated) {
    const account = activation.account ? ` · ${escapeHtml(activation.account)}` : "";
    return `<span class="status claimed" title="${escapeHtml(when)}${manual}">✅ 사용됨${account}</span>`;
  }
  if (activation.notFound) {
    return `<span class="status revoked" title="${escapeHtml(when)}${manual}">키 없음</span>`;
  }
  return `<span class="status bounced" title="${escapeHtml(when)}${manual}">⛔ 미사용</span>`;
}

// Compact cell for the creator × game matrix: summarizes one creator's state for one game.
// Cells without a saved record default to "미접촉" (display only — no record is created
// until the cell is edited and saved).
function matrixCellContent(record, profileId, gameId) {
  const status = record?.status || "uncontacted";
  const a = record?.steamActivation;
  // Usage (사용됨/미사용) is folded into the key chip's color instead of a separate
  // icon, so the key itself reads differently once it has been used.
  const usedState = a ? (a.activated ? "used" : "unused") : "";
  // Mail shortcut is always available (a creator can be emailed again after the
  // first contact), so the ✉ icon stays regardless of status.
  const mail = `<button type="button" class="matrix-mail" data-matrix-mail="${escapeHtml(profileId)}|${escapeHtml(gameId)}" title="메일 초안 보내기" aria-label="메일">✉</button>`;
  // Key/note/mail shown as icon chips so every cell stays the same size. Hover
  // reveals the full value (instant tooltip). Key click copies; note click opens
  // the cell editor (so the memo can be edited); the icons stay on one line.
  const code = record?.steamKey || record?.steamKeyMasked;
  const usedCls = usedState === "used" ? " is-used" : usedState === "unused" ? " is-unused" : "";
  const usedTip = usedState === "used" ? "\n✅ 사용됨" : usedState === "unused" ? "\n⛔ 미사용" : "";
  const keyChip = code
    ? `<span class="matrix-chip${usedCls}" data-copy="${escapeHtml(code)}" data-tip="🔑 ${escapeHtml(code)}${usedTip}\n클릭하여 복사" aria-label="스토어 키">🔑</span>`
    : "";
  const noteChip = record?.note
    ? `<span class="matrix-chip" data-matrix-note data-tip="📝 ${escapeHtml(record.note)}\n클릭하여 수정" aria-label="메모 수정">📝</span>`
    : "";
  const actions = `${mail}${keyChip}${noteChip}`;
  const actionsRow = actions ? `<span class="matrix-actions">${actions}</span>` : "";
  return `<span class="matrix-line"><span class="matrix-badge status ${escapeHtml(status)}${record ? "" : " is-empty"}" title="클릭하여 편집">${escapeHtml(CREATOR_STATUS_LABELS[status] || status)}</span>${actionsRow}</span>`;
}

// Instant, clipping-free tooltip for [data-tip] elements (matrix key/note chips
// live inside a scroll container, so a fixed-position bubble is used instead of
// a CSS ::after that would get cut off).
(function initHoverTips() {
  let tip = null;
  const place = (el) => {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "hover-tip";
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8; // flip below when there's no room above
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => { if (tip) tip.style.display = "none"; };
  document.addEventListener("mouseover", (event) => {
    const el = event.target.closest?.("[data-tip]");
    if (el) place(el);
  });
  document.addEventListener("mouseout", (event) => {
    if (event.target.closest?.("[data-tip]")) hide();
  });
  document.addEventListener("scroll", hide, true);
})();

// Creator × game matrix: rows = shared creator profiles, columns = games. Each cell is the
// per-game creator record (mail/key/usage at a glance); click to edit/create it.
function renderCreatorMatrix() {
  const wrap = $("#creatorMatrixWrap");
  if (!wrap) return;
  const cookie = state.settings?.steam || {};
  const cookieStatus = $("#keyTrackerCookieStatus");
  if (cookieStatus) {
    cookieStatus.textContent = cookie.partnerCookieConfigured ? "파트너 쿠키 설정됨" : "파트너 쿠키 미설정";
    cookieStatus.className = `status-pill ${cookie.partnerCookieConfigured ? "ok" : "fail"}`;
  }
  const refreshBtn = $("#creatorRefreshAll");
  if (refreshBtn) refreshBtn.disabled = !cookie.partnerCookieConfigured;
  const allGames = state.games.filter((g) => !g.archived);
  state.hiddenGames ||= new Set();
  renderGameFilter(allGames);
  const games = allGames.filter((g) => !state.hiddenGames.has(g.id));
  // Per-profile aggregates for sorting.
  const reviewCount = (id) => state.creators.filter((c) => c.creatorProfileId === id && c.status === "review").length;
  const sentCount = (id) => state.creators.filter((c) => c.creatorProfileId === id && ["sent", "review"].includes(c.status)).length;
  const sortMode = state.matrixSort || "name";
  const platformFilter = state.platformFilter || "all";
  const profiles = [...state.creatorProfiles]
    .filter((p) => platformFilter === "all" || (p.gamePlatforms || []).includes(platformFilter))
    .sort((a, b) => {
    if (sortMode === "reviews") return reviewCount(b.id) - reviewCount(a.id) || a.channelName.localeCompare(b.channelName);
    if (sortMode === "sent") return sentCount(b.id) - sentCount(a.id) || a.channelName.localeCompare(b.channelName);
    if (sortMode === "fit") return toNumber(b.fitScore) - toNumber(a.fitScore) || a.channelName.localeCompare(b.channelName);
    return a.channelName.localeCompare(b.channelName);
  });
  $("#creatorMatrixCount").textContent = `${number(profiles.length)}명 × ${number(games.length)}/${number(allGames.length)}게임`;
  if (!profiles.length || !allGames.length) {
    wrap.innerHTML = '<div class="empty" style="padding:16px">크리에이터와 게임이 있어야 매트릭스가 표시됩니다.</div>';
    return;
  }
  if (!games.length) {
    wrap.innerHTML = '<div class="empty" style="padding:16px">표시할 게임을 필터에서 선택하세요.</div>';
    return;
  }
  // index per-game records by profile+game
  const byKey = new Map();
  for (const c of state.creators) byKey.set(`${c.creatorProfileId}::${c.gameId}`, c);
  const gameHead = games
    .map((g) => {
      const thumb = g.imageUrl
        ? `<img class="matrix-game-thumb" src="${escapeHtml(g.imageUrl)}" alt="" loading="lazy" />`
        : `<span class="matrix-game-thumb placeholder" style="--mono-h:${hueFromString(g.name)}" aria-hidden="true">${escapeHtml(monogram(g.name))}</span>`;
      return `<th class="matrix-game-col"><div class="matrix-game-head">${thumb}<span>${escapeHtml(g.name)}</span></div></th>`;
    })
    .join("");
  const head = `<tr><th class="matrix-name-col">크리에이터</th><th class="matrix-chan-col">채널</th><th class="matrix-act-col">관리</th>${gameHead}<th class="matrix-spacer"></th></tr>`;
  const body = profiles
    .map((p) => {
      const cells = games
        .map((g) => {
          const rec = byKey.get(`${p.id}::${g.id}`);
          return `<td class="matrix-cell-td"><div class="matrix-cell" role="button" tabindex="0" data-matrix-profile="${escapeHtml(p.id)}" data-matrix-game="${escapeHtml(g.id)}">${matrixCellContent(rec, p.id, g.id)}</div></td>`;
        })
        .join("");
      const icons = channelIconsHtml(p);
      const sub = p.email
        ? `<span class="cell-sub cell-copy" data-copy="${escapeHtml(p.email)}" title="클릭하여 이메일 복사">${escapeHtml(p.email)}</span>`
        : `<span class="cell-sub">${escapeHtml(p.country || "")}</span>`;
      const platforms = (p.gamePlatforms || [])
        .map((pf) => `<span class="plat-chip plat-${escapeHtml(pf.toLowerCase())}">${escapeHtml(pf.replace(/_/g, " "))}</span>`)
        .join("");
      const nameCell = `<td class="matrix-name-col"><span class="cell-title-line"><span class="cell-title" title="${escapeHtml(p.channelName)}">${escapeHtml(p.channelName)}</span>${platforms}</span>${sub}</td>`;
      const chanCell = `<td class="matrix-chan-col"><div class="channel-links">${icons || '<span class="cell-sub">-</span>'}</div></td>`;
      const actions = `<td class="matrix-act-col"><div class="icon-actions">
        <button type="button" class="icon-btn" data-edit-profile="${escapeHtml(p.id)}" title="편집" aria-label="편집">${ICON_EDIT}</button>
        <button type="button" class="icon-btn danger" data-del-profile="${escapeHtml(p.id)}" title="삭제" aria-label="삭제">${ICON_TRASH}</button>
      </div></td>`;
      return `<tr>${nameCell}${chanCell}${actions}${cells}<td class="matrix-spacer"></td></tr>`;
    })
    .join("");
  wrap.innerHTML = `<table class="matrix-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Product-column visibility filter (only useful when several products exist —
// hidden entirely in the single-product workspace).
function renderGameFilter(allGames) {
  const panel = $("#matrixGameFilter");
  if (!panel) return;
  const details = panel.closest("details");
  if (details) details.hidden = allGames.length <= 1;
  const shown = allGames.filter((g) => !state.hiddenGames.has(g.id)).length;
  $("#matrixGameFilterSummary").textContent = `제품 ${shown}/${allGames.length}`;
  panel.innerHTML =
    allGames
      .map(
        (g) =>
          `<label class="matrix-filter-item"><input type="checkbox" data-game-toggle="${escapeHtml(g.id)}" ${state.hiddenGames.has(g.id) ? "" : "checked"} /> ${escapeHtml(g.name)}</label>`,
      )
      .join("") + '<div class="matrix-filter-actions"><button type="button" id="matrixGameAll">전체</button><button type="button" id="matrixGameNone">모두 해제</button></div>';
}

// Renders a CSV preview into the import modal. `type` is "keys" (per-game tracker) or
// "profiles" (shared creator DB), which selects the column layout.
function renderCsvModalPreview(preview, type) {
  const head =
    type === "profiles"
      ? "<th>채널</th><th>플랫폼</th><th>이메일</th><th>태그</th><th>조회수</th><th>적합도</th>"
      : type === "pool"
        ? "<th>Key</th><th>유형</th><th>라벨</th><th>메모</th>"
        : "<th>대상</th><th>구분</th><th>연락처</th><th>국가</th><th>Key</th><th>발송일</th><th>상태</th>";
  const colspan = type === "profiles" ? 6 : type === "pool" ? 4 : 7;
  const rowHtml = (row) =>
    type === "profiles"
      ? `<tr><td>${escapeHtml(row.channelName)}</td><td>${escapeHtml(row.platform)}</td><td>${escapeHtml(row.email || "-")}</td><td>${escapeHtml((row.tags || []).join(", "))}</td><td class="num">${number(row.averageViews)}</td><td class="num">${number(row.fitScore)}</td></tr>`
      : type === "pool"
        ? `<tr><td><code>${escapeHtml(row.masked)}</code></td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.label || "-")}</td><td>${escapeHtml(row.note || "-")}</td></tr>`
        : `<tr><td>${escapeHtml(row.channelName)}</td><td>${escapeHtml(KEY_TYPE_LABELS[row.recipientType] || row.recipientType || "-")}</td><td>${escapeHtml(row.email || "-")}</td><td>${escapeHtml(row.country || "-")}</td><td><code>${escapeHtml(row.steamKeyMasked)}</code></td><td>${escapeHtml(row.sentAt || "-")}</td><td>${escapeHtml(CREATOR_STATUS_LABELS[row.status] || row.status)}</td></tr>`;
  $("#csvModalPreview").innerHTML = `
    <div class="preview-grid">
      <div class="preview-stats">
        <span>${number(preview.totalRows)} rows</span>
        <span>${number(preview.newRows)} new</span>
        <span>${number(preview.updateRows)} update</span>
        <span>${number(preview.duplicateRows)} duplicate</span>
      </div>
      ${preview.warnings?.length ? `<div class="empty">${preview.warnings.map((w) => escapeHtml(w)).join("<br>")}</div>` : ""}
      <div class="table-wrap compact">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>
            ${
              preview.previewRows?.length
                ? preview.previewRows.map(rowHtml).join("")
                : `<tr><td colspan="${colspan}"><span class="empty">미리볼 행이 없습니다.</span></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderMetrics() {
  $("#metricCount").textContent = `${number(state.metrics.length)}건`;
  if (!state.metrics.length) {
    $("#metricTable").innerHTML = '<tr><td data-label="상태" colspan="7"><span class="empty">Steam 지표가 없습니다.</span></td></tr>';
    return;
  }
  $("#metricTable").innerHTML = state.metrics
    .slice(0, 50)
    .map(
      (metric) => `
        <tr>
          <td data-label="날짜">${escapeHtml(metric.date)}</td>
          <td data-label="게임">${escapeHtml(metric.gameName || gameName(metric.gameId))}</td>
          <td data-label="캠페인"><span class="cell-title">${escapeHtml(metric.campaignName)}</span></td>
          <td data-label="국가">${escapeHtml(metric.country)}</td>
          <td data-label="방문" class="num">${number(metric.visits)}</td>
          <td data-label="위시" class="num">${number(metric.wishlists)}</td>
          <td data-label="구매" class="num">${number(metric.purchases)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderSyncStatus() {
  const status = state.syncStatus;
  if (!status) return;
  $("#syncConfigured").innerHTML = status.configured
    ? '<span class="status launched">configured</span>'
    : '<span class="status concept">missing key</span>';
  $("#syncLastRun").textContent = status.lastRunAt ? `최근 실행 ${new Date(status.lastRunAt).toLocaleString("ko-KR")}` : "아직 실행 없음";
  $("#syncStatusGrid").innerHTML = [
    ["API 키", status.keyEnv],
    ["App ID 게임", `${number(status.gamesWithAppIds)} / ${number(status.totalGames)}`],
    ["판매 워터마크", status.salesHighwatermark || "0"],
    ["최근 상태", status.lastStatus || "never_run"],
  ]
    .map(([label, value]) => `<div class="sync-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const rows = status.recentRuns || [];
  $("#syncRunTable").innerHTML = rows.length
    ? rows
        .map(
          (run) => `
        <tr>
          <td data-label="시간">${escapeHtml(run.finishedAt || run.startedAt)}</td>
          <td data-label="상태"><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
          <td data-label="범위">${escapeHtml(run.gameId || "all")}<span class="cell-sub">${escapeHtml(run.startDate || "-")} ~ ${escapeHtml(run.endDate || "-")}</span></td>
          <td data-label="결과" class="num">${number(run.inserted)} new / ${number(run.updated)} upd<span class="cell-sub">${number((run.events || []).length)} events</span></td>
          <td data-label="메시지">${escapeHtml((run.warnings || [])[0] || "ok")}</td>
          <td data-label="상세"><button class="secondary-button table-button" type="button" data-sync-run-id="${escapeHtml(run.id)}">보기</button></td>
        </tr>
      `,
        )
        .join("")
    : '<tr><td data-label="상태" colspan="6"><span class="empty">동기화 실행 기록이 없습니다.</span></td></tr>';
}

function renderSyncSchedule() {
  const schedule = state.syncSchedule;
  if (!schedule) return;
  $("#syncScheduleStatus").innerHTML = `
    <div class="preview-stats">
      <span>${schedule.enabled ? "on" : "off"}</span>
      <span>${escapeHtml(schedule.gameId || "all")}</span>
      <span>${number(schedule.intervalHours)}h</span>
      <span>next ${escapeHtml(schedule.nextRunAt || "-")}</span>
      <span>${escapeHtml(schedule.lastStatus || "never_run")}</span>
    </div>
  `;
}

function renderEmailStatus() {
  const status = state.emailStatus;
  if (!status) return;
  const label = $("#emailStatusLabel");
  if (!status.configured) {
    label.textContent = "발송 미설정";
    label.className = "status-pill fail";
  } else if (status.mode === "graph") {
    label.textContent = "Graph 발송 설정됨";
    label.className = "status-pill ok";
  } else if (status.mode === "log") {
    label.textContent = "로그 모드 (실제 발송 안 함)";
    label.className = "status-pill";
  } else {
    label.textContent = "SMTP 발송 설정됨";
    label.className = "status-pill ok";
  }
  const pills = [
    ["모드", status.mode],
    ["발신", status.from],
    ["인증", status.auth],
  ];
  if (status.mode === "smtp") pills.splice(1, 0, ["호스트", `${status.host}:${status.port}`]);
  $("#emailStatusGrid").innerHTML = pills
    .map(([k, v]) => `<span class="email-pill"><b>${escapeHtml(k)}</b> ${escapeHtml(String(v))}</span>`)
    .join("");
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  const steam = settings.steam || {};
  const email = settings.email || {};
  const steamLabel = steam.configured ? `Steam ${steam.source}` : "Steam missing";
  const emailLabel = email.configured ? `Email ${email.mode}/${email.source}` : "Email missing";
  $("#settingsSummary").textContent = `${steamLabel} · ${emailLabel}`;

  const steamStatus = $("#steamSettingsStatus");
  steamStatus.textContent = steam.configured ? steam.source : "missing";
  steamStatus.className = `status-pill ${steam.configured ? "ok" : "fail"}`;
  $("#steamSettingsMeta").textContent = steam.configured ? `key ${steam.keyMasked || "stored"}` : "key not configured";
  const cookieMeta = $("#steamPartnerCookieMeta");
  if (cookieMeta) {
    cookieMeta.textContent = steam.partnerCookieConfigured
      ? `설정됨 ${steam.partnerCookieUpdatedAt ? `(${formatDateTime(steam.partnerCookieUpdatedAt)})` : ""}`
      : "미설정";
    cookieMeta.className = steam.partnerCookieConfigured ? "muted ok-text" : "muted";
  }

  const emailStatus = $("#emailSettingsStatus");
  emailStatus.textContent = email.configured ? email.mode : "missing";
  emailStatus.className = `status-pill ${email.configured ? "ok" : "fail"}`;
  $("#emailSettingsMeta").textContent = email.configured
    ? `${email.host}:${email.port} · ${email.from} · auth ${email.auth}`
    : email.mode === "graph"
      ? "graph not configured"
      : "smtp not configured";

  $("#settingsResult").innerHTML = `
    ${[
      ["Steam source", steam.configured ? steam.source : "missing", steam.keyMasked || "no key"],
      ["Email source", email.configured ? email.source : "missing", email.passwordMasked || "no smtp password"],
      ["Transport", email.configured ? `${email.mode} / TLS ${email.starttls ? "on" : "off"}` : "missing", email.secure ? "secure socket" : "standard socket"],
      ["Updated", settings.form?.updatedAt || "-", "encrypted at rest"],
    ]
      .map(
        ([label, value, detail]) => `
          <div class="settings-state-item">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(detail)}</small>
          </div>
        `,
      )
      .join("")}
  `;

  const steamForm = $("#steamSettingsForm");
  steamForm.elements.steamFinancialApiKey.value = "";
  steamForm.elements.clearSteamFinancialApiKey.checked = false;
  if (steamForm.elements.steamPartnerCookie) steamForm.elements.steamPartnerCookie.value = "";
  if (steamForm.elements.clearSteamPartnerCookie) steamForm.elements.clearSteamPartnerCookie.checked = false;

  const form = $("#emailSettingsForm");
  const values = settings.form || {};
  form.elements.smtpHost.value = values.smtpHost || "";
  form.elements.smtpPort.value = values.smtpPort || 587;
  form.elements.smtpUser.value = values.smtpUser || "";
  form.elements.smtpPass.value = "";
  form.elements.emailFrom.value = values.emailFrom || "";
  form.elements.emailReplyTo.value = values.emailReplyTo || "";
  form.elements.emailSendMode.value = values.emailSendMode || "smtp";
  form.elements.smtpSecure.value = String(Boolean(values.smtpSecure));
  form.elements.smtpStarttls.value = String(values.smtpStarttls !== false);
  form.elements.clearSmtpPass.checked = false;
  form.elements.graphSendMailbox.value = values.graphSendMailbox || "";
  form.elements.graphTenantId.value = values.graphTenantId || "";
  form.elements.graphClientId.value = values.graphClientId || "";
  form.elements.graphClientSecret.value = "";
  form.elements.clearGraphClientSecret.checked = false;
  toggleEmailModeFields(form);
}

// Show only the fields relevant to the selected send mode (smtp / graph / log).
function toggleEmailModeFields(form) {
  const mode = form.elements.emailSendMode.value || "smtp";
  form.querySelectorAll(".smtp-only").forEach((el) => {
    el.hidden = mode !== "smtp";
  });
  form.querySelectorAll(".graph-only").forEach((el) => {
    el.hidden = mode !== "graph";
  });
}

function fmtLogTime(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v || "-") : d.toLocaleString("ko-KR", { hour12: false });
}

function renderOutreachLogs() {
  $("#outreachLogCount").textContent = `최근 30일 ${number(state.outreachLogs.length)}개`;
  if (!state.outreachLogs.length) {
    $("#outreachLogTable").innerHTML = '<tr><td data-label="상태" colspan="4"><span class="empty">최근 30일 발송 로그가 없습니다.</span></td></tr>';
    return;
  }
  $("#outreachLogTable").innerHTML = state.outreachLogs
    .map(
      (log) => `
        <tr>
          <td data-label="시간">${escapeHtml(fmtLogTime(log.createdAt))}</td>
          <td data-label="상태"><span class="status ${escapeHtml(log.status)}">${escapeHtml(log.status)}</span></td>
          <td data-label="크리에이터">${escapeHtml(log.creatorName || log.to || "-")}<span class="cell-sub">${escapeHtml(log.gameName || "")}</span></td>
          <td data-label="제목"><span class="cell-title">${escapeHtml(log.subject || "-")}</span><span class="cell-sub">${escapeHtml(log.message || log.error || "")}</span></td>
        </tr>
      `,
    )
    .join("");
}

function renderSyncRunDetail(run) {
  const events = run.events || [];
  $("#syncRunDetail").innerHTML = `
    <div class="preview-grid">
      <div class="preview-stats">
        <span>${escapeHtml(run.status)}</span>
        <span>${number(run.inserted)} new</span>
        <span>${number(run.updated)} updated</span>
        <span>${number(events.length)} events</span>
      </div>
      <div class="cell-sub">${escapeHtml(run.startedAt || "-")} ~ ${escapeHtml(run.finishedAt || "-")}</div>
      ${
        run.warnings?.length
          ? `<div class="empty">${run.warnings.map((warning) => escapeHtml(warning)).join("<br>")}</div>`
          : ""
      }
      <div class="table-wrap compact">
        <table>
          <thead><tr><th>Type</th><th>Game</th><th>Date</th><th>Rows</th></tr></thead>
          <tbody>
            ${
              events.length
                ? events
                    .slice(0, 20)
                    .map(
                      (event) => `
                        <tr>
                          <td data-label="Type">${escapeHtml(event.type || "-")}</td>
                          <td data-label="Game">${escapeHtml(event.gameId || event.appid || "-")}</td>
                          <td data-label="Date">${escapeHtml(event.date || "-")}</td>
                          <td data-label="Rows" class="num">${number(event.rows || 0)}</td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td data-label="상태" colspan="4"><span class="empty">이벤트가 없습니다.</span></td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// Dedicated mail compose modal: editable to/subject/body, open-in-mail-app or SMTP send,
// and marks the creator as 발송 automatically.
let openMailModal = null;
function initMailModal() {
  const modal = $("#mailModal");
  if (!modal) return;
  let ctx = { profileId: null, gameId: null, recordId: null };

  // The body is a rich (HTML) editor; the Korean panel stays a plain textarea.
  // Read/write each as the right type (the body round-trips through plain text
  // for translation, which is inherently text-based).
  const readField = (sel) => (sel === "#mailBody" ? htmlToText(getRich($("#mailBody"))) : $(sel).value || "");
  const writeField = (sel, text) => {
    if (sel === "#mailBody") setRich($("#mailBody"), plainToHtml(text));
    else $(sel).value = text;
  };

  // Regenerate the draft from the currently selected template + language.
  async function loadDraft() {
    let draft = {};
    try {
      draft = await api("/api/email-drafts", {
        method: "POST",
        body: {
          ...(ctx.recordId ? { creatorId: ctx.recordId } : { creatorProfileId: ctx.profileId }),
          gameId: ctx.gameId,
          templateId: $("#mailTemplate").value || undefined,
          lang: $("#mailLang").value,
        },
      });
    } catch (error) {
      showToast(error.message);
      return;
    }
    $("#mailTo").value = draft.to || "";
    $("#mailSubject").value = draft.subject || "";
    setRich($("#mailBody"), draft.body);
    const utm = draft.utmLink || "";
    $("#mailUtm").textContent = utm || "-";
    $("#mailUtm").href = utm || "#";
    // The Korean view is a translation of the previous body — clear it so a
    // stale translation isn't mistaken for the new draft.
    const koEl = $("#mailBodyKo");
    if (koEl) koEl.value = "";
    const koStatus = $("#mailKoStatus");
    if (koStatus) koStatus.textContent = "";
  }

  async function open(profileId, gameId) {
    const profile = state.creatorProfiles.find((p) => p.id === profileId);
    const game = state.games.find((g) => g.id === gameId);
    const rec = state.creators.find((c) => c.creatorProfileId === profileId && c.gameId === gameId);
    ctx = { profileId, gameId, recordId: rec?.id || null };
    $("#mailModalTitle").textContent = `메일 — ${profile?.channelName || ""} · ${game?.name || ""}`;
    const templates = state.emailTemplates || [];
    $("#mailTemplate").innerHTML =
      '<option value="">(기본 양식)</option>' + templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
    // Default to the most recently used template (remembered across opens);
    // fall back to the review-request template on first use.
    let lastUsed = null;
    try {
      lastUsed = localStorage.getItem("lp:lastMailTemplateId");
    } catch {
      /* localStorage unavailable (private mode) — ignore */
    }
    if (lastUsed !== null && (lastUsed === "" || templates.some((t) => t.id === lastUsed))) {
      $("#mailTemplate").value = lastUsed;
    } else {
      $("#mailTemplate").value = templates.some((t) => t.id === "tmpl_review_request") ? "tmpl_review_request" : "";
    }
    $("#mailLang").value = /kr|ko|한국|korea/i.test(profile?.country || "") ? "ko" : "en";
    const email = state.settings?.email || {};
    $("#mailSmtpBtn").disabled = !email.configured;
    $("#mailStatusHint").textContent = email.configured
      ? `메일 발송 가능 (${email.mode || "smtp"})`
      : "메일 발송 미설정 — '메일 앱으로 열기'로 보내세요.";
    renderMailKey();
    await loadDraft();
    modal.showModal();
  }
  openMailModal = open;

  // Key assignment from inside the mail modal: if this creator×game has no key,
  // assign one from the game's pool (reuses the same /assign-key API as the
  // matrix cell editor), then refresh the draft so {{key}} fills in.
  function currentMailRec() {
    return state.creators.find((c) => c.creatorProfileId === ctx.profileId && c.gameId === ctx.gameId) || null;
  }
  function renderMailKey() {
    if (!$("#mailKeyRow")) return;
    const rec = currentMailRec();
    const poolKeys = state.keyPool.filter((e) => e.gameId === ctx.gameId);
    const pickable = poolKeys.filter((e) => e.available || e.id === rec?.keyPoolId);
    const hasKey = Boolean(rec?.steamKeyMasked || rec?.steamKey);
    const statusEl = $("#mailKeyStatus");
    if (statusEl) {
      statusEl.textContent = hasKey
        ? `🔑 배정됨: ${rec.steamKeyMasked || rec.steamKey}${rec.keyPoolId ? " (풀)" : ""}`
        : "🔑 배정된 키 없음";
      statusEl.classList.toggle("has-key", hasKey);
    }
    $("#mailPoolSelect").innerHTML =
      '<option value="">— 풀 키 선택 —</option>' +
      pickable
        .map(
          (e) =>
            `<option value="${escapeHtml(e.id)}"${e.id === rec?.keyPoolId ? " selected" : ""}>${escapeHtml(e.masked)} · ${escapeHtml(poolTypeLabel(e))} · ${e.assignedCount}/${e.maxUses == null ? "∞" : e.maxUses}</option>`,
        )
        .join("");
    const remaining = poolKeys.filter((e) => e.available).length;
    $("#mailPoolRemaining").textContent = poolKeys.length
      ? `풀 잔여 ${remaining}개 / 전체 ${poolKeys.length}개`
      : "이 게임의 풀에 키가 없습니다 (키 풀 탭에서 등록).";
    $("#mailUnassignBtn").hidden = !rec?.keyPoolId;
  }
  async function ensureMailRecord() {
    const rec = currentMailRec();
    if (rec) {
      ctx.recordId = rec.id;
      return rec.id;
    }
    const profile = state.creatorProfiles.find((p) => p.id === ctx.profileId);
    const created = await api("/api/creators", {
      method: "POST",
      body: {
        gameId: ctx.gameId,
        creatorProfileId: ctx.profileId,
        channelName: profile?.channelName || "",
        email: profile?.email || "",
        country: profile?.country || "",
        platform: profile?.platform || "",
      },
    });
    ctx.recordId = created.id;
    return created.id;
  }
  async function assignMailPoolKey(keyPoolId) {
    const id = await ensureMailRecord();
    await api(`/api/creators/${encodeURIComponent(id)}/assign-key`, { method: "POST", body: keyPoolId ? { keyPoolId } : {} });
    showToast("키를 배정했습니다.");
    await loadAll();
    renderMailKey();
    await loadDraft(); // the body's {{key}} placeholder now fills in
  }
  $("#mailAssignBtn")?.addEventListener("click", async () => {
    try {
      await assignMailPoolKey($("#mailPoolSelect").value); // empty = auto next available
    } catch (error) {
      showToast(error.message);
    }
  });
  $("#mailPoolSelect")?.addEventListener("change", async (event) => {
    const keyPoolId = event.target.value;
    if (!keyPoolId) return;
    try {
      await assignMailPoolKey(keyPoolId);
    } catch (error) {
      showToast(error.message);
      renderMailKey();
    }
  });
  $("#mailUnassignBtn")?.addEventListener("click", async () => {
    if (!ctx.recordId) return;
    try {
      await api(`/api/creators/${encodeURIComponent(ctx.recordId)}/unassign-key`, { method: "POST", body: {} });
      showToast("키를 회수했습니다.");
      await loadAll();
      renderMailKey();
      await loadDraft();
    } catch (error) {
      showToast(error.message);
    }
  });
  $("#mailTemplate").addEventListener("change", () => {
    try {
      localStorage.setItem("lp:lastMailTemplateId", $("#mailTemplate").value);
    } catch {
      /* localStorage unavailable — selection just won't be remembered */
    }
    loadDraft();
  });
  $("#mailLang").addEventListener("change", loadDraft);

  // AI translation: read/edit the email in Korean, then push edits back into the
  // sending language. Convenience for a Korean sender writing non-Korean mail.
  async function translateBody(targetLang, sourceId, destId) {
    const src = readField(sourceId).trim();
    const statusEl = $("#mailKoStatus");
    if (!src) {
      showToast(sourceId === "#mailBody" ? "번역할 본문이 없습니다." : "반영할 한글 내용이 없습니다.");
      return;
    }
    const btns = [$("#mailToKo"), $("#mailFromKo")];
    btns.forEach((b) => b && (b.disabled = true));
    if (statusEl) statusEl.textContent = "번역 중…";
    try {
      const r = await api("/api/ai/translate", { method: "POST", body: { text: src, targetLang } });
      writeField(destId, r.text || "");
      if (statusEl) {
        statusEl.textContent =
          destId === "#mailBodyKo"
            ? "한글 번역 완료 — 편집 후 '한글 → 본문 반영'을 누르세요."
            : "한글 편집 내용을 본문에 반영했습니다.";
      }
    } catch (error) {
      if (statusEl) statusEl.textContent = "";
      showToast(error.message || "번역에 실패했습니다.");
    } finally {
      btns.forEach((b) => b && (b.disabled = false));
    }
  }
  $("#mailToKo")?.addEventListener("click", () => translateBody("ko", "#mailBody", "#mailBodyKo"));
  $("#mailFromKo")?.addEventListener("click", () => translateBody($("#mailLang").value, "#mailBodyKo", "#mailBody"));

  const mailtoUrl = () =>
    `mailto:${encodeURIComponent($("#mailTo").value.trim())}?subject=${encodeURIComponent($("#mailSubject").value)}&body=${encodeURIComponent(htmlToText(getRich($("#mailBody"))))}`;

  // Bump the creator to 발송 (creating the per-game record if needed) and append a
  // "메일 발송 <시각>" line to the memo so the send is logged automatically.
  async function markContacted() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const logLine = `📧 메일 발송 ${stamp}`;
    if (ctx.recordId) {
      const rec = state.creators.find((c) => c.id === ctx.recordId);
      const body = { note: rec?.note ? `${rec.note}\n${logLine}` : logLine };
      if (rec && rec.status === "uncontacted") body.status = "sent";
      await api(`/api/creators/${encodeURIComponent(ctx.recordId)}`, { method: "PUT", body });
    } else {
      const profile = state.creatorProfiles.find((p) => p.id === ctx.profileId);
      await api("/api/creators", {
        method: "POST",
        body: { gameId: ctx.gameId, creatorProfileId: ctx.profileId, channelName: profile?.channelName || "", email: profile?.email || "", status: "sent", note: logLine },
      });
    }
  }

  modal.querySelectorAll("[data-mail-close]").forEach((b) => b.addEventListener("click", () => modal.close()));
  $("#mailCopyBody").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(htmlToText(getRich($("#mailBody"))));
      showToast("본문을 복사했습니다.");
    } catch {
      showToast("복사 실패 — 직접 선택해 복사하세요.");
    }
  });
  $("#mailCopyUtm").addEventListener("click", async () => {
    const u = $("#mailUtm").textContent;
    if (!u || u === "-") return;
    try {
      await navigator.clipboard.writeText(u);
      showToast("링크를 복사했습니다.");
    } catch {
      showToast("복사 실패");
    }
  });
  $("#mailOpenBtn").addEventListener("click", async () => {
    window.open(mailtoUrl(), "_blank");
    try {
      await markContacted();
    } catch (error) {
      showToast(error.message);
    }
    showToast("메일 앱을 열었습니다 · 상태: 발송");
    modal.close();
    await loadAll();
  });
  $("#mailSmtpBtn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const draft = {
        to: $("#mailTo").value.trim(),
        subject: $("#mailSubject").value,
        body: getRich($("#mailBody")),
        utmLink: $("#mailUtm").textContent,
        gameId: ctx.gameId,
        creatorId: ctx.recordId || "",
        creatorProfileId: ctx.recordId ? "" : ctx.profileId,
      };
      const result = await api("/api/email-send", { method: "POST", body: { draft } });
      await markContacted();
      showToast(result.message || result.status || "발송 처리했습니다.");
      modal.close();
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderCsvPreview(preview) {
  $("#csvPreviewResult").innerHTML = `
    <div class="preview-grid">
      <div class="preview-stats">
        <span>${number(preview.totalRows)} rows</span>
        <span>${number(preview.newRows)} new</span>
        <span>${number(preview.replaceRows)} replace</span>
        <span>${number(preview.duplicateRows)} duplicate</span>
      </div>
      ${
        preview.warnings?.length
          ? `<div class="empty">${preview.warnings.map((warning) => escapeHtml(warning)).join("<br>")}</div>`
          : ""
      }
      <div class="table-wrap compact">
        <table>
          <thead>
            <tr><th>날짜</th><th>게임</th><th>캠페인</th><th>국가</th><th>방문</th><th>위시</th><th>구매</th></tr>
          </thead>
          <tbody>
            ${
              preview.previewRows?.length
                ? preview.previewRows
                    .map(
                      (row) => `
                        <tr>
                          <td data-label="날짜">${escapeHtml(row.date)}</td>
                          <td data-label="게임">${escapeHtml(row.gameName || gameName(row.gameId))}</td>
                          <td data-label="캠페인">${escapeHtml(row.campaignName)}</td>
                          <td data-label="국가">${escapeHtml(row.country)}</td>
                          <td data-label="방문" class="num">${number(row.visits)}</td>
                          <td data-label="위시" class="num">${number(row.wishlists)}</td>
                          <td data-label="구매" class="num">${number(row.purchases)}</td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td data-label="상태" colspan="7"><span class="empty">미리볼 행이 없습니다.</span></td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(",")).join("\n");
  // BOM so Excel reads UTF-8 Korean correctly.
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderAll() {
  renderGameSelectors();
  renderGameAdmin();
  renderDashboard();
  renderReadiness();
  renderCampaigns();
  renderCreatorMatrix();
  renderMetrics();
  renderSyncStatus();
  renderSyncSchedule();
  renderEmailStatus();
  renderSettings();
  renderOutreachLogs();
  renderYoutube();
  renderRedditPosts();
  renderDiscovery();
  renderKeyPool();
}

// Per-game key pool table in the distribution tab.
function poolTypeLabel(entry) {
  if (entry.type === "single") return "1회용";
  if (entry.maxUses == null) return "다회용·무제한";
  return `다회용·상한 ${entry.maxUses}`;
}

function renderKeyPool() {
  const wrap = $("#keyPoolTableWrap");
  if (!wrap) return;
  const gameId = $("#keyPoolGame")?.value || "";
  const game = gameById(gameId);
  const thumbEl = $("#keyPoolGameThumb");
  if (thumbEl) thumbEl.innerHTML = game ? gameThumb(game, "game-thumb--sm") : "";
  if (!gameId) {
    const summary = $("#keyPoolSummary");
    if (summary) summary.textContent = "게임 미선택";
    wrap.innerHTML = '<table><tbody><tr><td><span class="empty">위에서 게임을 먼저 선택하세요.</span></td></tr></tbody></table>';
    return;
  }
  const rows = state.keyPool.filter((e) => e.gameId === gameId);
  const avail = rows.filter((e) => e.available).length;
  const summary = $("#keyPoolSummary");
  if (summary) summary.textContent = rows.length ? `키 ${number(rows.length)}개 · 가용 ${number(avail)}` : "키 없음";
  if (!rows.length) {
    wrap.innerHTML = '<table><tbody><tr><td><span class="empty">등록된 키가 없습니다. "키 추가" 또는 CSV로 등록하세요.</span></td></tr></tbody></table>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>게임</th><th>Key</th><th>유형</th><th>사용</th><th>상태</th><th>라벨</th><th>배정 대상</th><th>등록일</th><th>작업</th></tr></thead>
      <tbody>
        ${rows
          .map((e) => {
            const total = e.maxUses == null ? "∞" : e.maxUses;
            const badge = e.available
              ? '<span class="pool-badge available">가용</span>'
              : '<span class="pool-badge exhausted">소진</span>';
            return `<tr>
              <td data-label="게임"><span class="key-pool-row-game">${gameThumb(game, "game-thumb--sm")}<span>${escapeHtml(game?.name || "—")}</span></span></td>
              <td data-label="Key"><span class="matrix-chip" data-copy="${escapeHtml(e.value || e.masked)}" data-tip="🔑 ${escapeHtml(e.value || e.masked)}\n클릭하여 복사">🔑</span> <code>${escapeHtml(e.masked)}</code></td>
              <td data-label="유형">${escapeHtml(poolTypeLabel(e))}</td>
              <td data-label="사용" class="num">${number(e.assignedCount)} / ${total}</td>
              <td data-label="상태">${badge}</td>
              <td data-label="라벨">${escapeHtml(e.label || "-")}</td>
              <td data-label="배정 대상">${e.assignedTo?.length ? escapeHtml(e.assignedTo.join(", ")) : "-"}</td>
              <td data-label="등록일" class="muted nowrap">${escapeHtml(formatDateTime(e.createdAt) || "-")}</td>
              <td data-label="작업"><button type="button" class="secondary-button table-button danger-button" data-del-pool="${escapeHtml(e.id)}">삭제</button></td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function setGameScope(gameId) {
  state.selectedGameId = gameId || "all";
  await loadAll();
}

async function loadAll() {
  const status = $("#apiStatus");
  status.textContent = "API 확인 중";
  status.className = "status-pill";
  const query = gameQuery();
  const [
    health,
    games,
    storeListings,
    dashboard,
    readiness,
    campaigns,
    creatorProfiles,
    creators,
    metrics,
    syncStatus,
    syncSchedule,
    settings,
    emailStatus,
    outreachLogs,
    youtube,
    redditPosts,
    emailTemplates,
    discovery,
    keyPool,
  ] = await Promise.all([
    api("/api/health"),
    api("/api/games"),
    api("/api/store-listings?includeArchived=true"),
    api(`/api/dashboard?${query}&clientDate=${localDateString()}`),
    api("/api/readiness"),
    api(`/api/campaigns?${query}`),
    api("/api/creator-profiles"),
    api("/api/creators?gameId=all"),
    api(`/api/steam-metrics?${query}`),
    api("/api/steam-sync/status"),
    api("/api/sync-schedule"),
    api("/api/settings"),
    api("/api/email/status"),
    api(`/api/outreach-logs?${query}&days=30`),
    api("/api/youtube"),
    api(`/api/reddit-posts?${query}`),
    api("/api/email-templates"),
    // Discovery is optional/best-effort — a failure here must not blank the app.
    api("/api/discovery").catch(() => state.discovery),
    api("/api/key-pool?gameId=all").catch(() => state.keyPool),
  ]);
  state.keyPool = keyPool;
  state.games = games;
  state.storeListings = storeListings;
  state.dashboard = dashboard;
  state.readiness = readiness;
  state.campaigns = campaigns;
  state.creatorProfiles = creatorProfiles;
  state.creators = creators;
  state.metrics = metrics;
  state.syncStatus = syncStatus;
  state.syncSchedule = syncSchedule;
  state.settings = settings;
  state.emailStatus = emailStatus;
  state.outreachLogs = outreachLogs;
  const prevYt = state.youtube || {};
  state.youtube = {
    ...youtube,
    selectedChannelId: prevYt.selectedChannelId || youtube.channels[0]?.id || null,
    selectedDays: prevYt.selectedDays || 28,
    analytics: prevYt.analytics || null,
    analyticsKey: prevYt.analyticsKey || "",
    analyticsError: prevYt.analyticsError || "",
    analyticsLoading: false,
  };
  state.redditPosts = redditPosts;
  state.emailTemplates = emailTemplates;
  if (discovery) state.discovery = discovery;
  status.textContent = health.ok ? "API 정상" : "API 응답 확인 필요";
  status.classList.add(health.ok ? "ok" : "fail");
  renderAll();
}

function withSelectedGame(data) {
  return {
    ...data,
    gameId: data.gameId || selectedGameForForms(),
  };
}

function bindForm(selector, handler, options = {}) {
  const form = $(selector);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = form.querySelector("button[type='submit']");
    submitter.disabled = true;
    try {
      await handler(formData(form), form);
      await loadAll();
      if (!options.keepValues) form.reset();
      if (!options.keepValues) form.closest("details")?.removeAttribute("open");
      renderGameSelectors();
      showToast("저장했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      submitter.disabled = false;
    }
  });
}

// CSV import is occasional, so it lives in a dedicated modal (one dialog reused for both the
// per-game key tracker and the shared creator DB) rather than cluttering each section inline.
function initCsvImportModal() {
  const modal = $("#csvImportModal");
  if (!modal) return;
  const CONFIG = {
    keys: {
      title: "키 트래커 CSV 가져오기 (엑셀 형식)",
      game: true,
      previewPath: "/api/import/key-csv/preview",
      importPath: "/api/import/key-csv",
      placeholder: "No,Key,대상,대상 구분,연락처,국가/언어,발송일,엠바고 (KST),상태,채널/프로필 URL,메모",
    },
    profiles: {
      title: "공용 크리에이터 DB CSV 가져오기",
      game: false,
      previewPath: "/api/import/creator-csv/preview",
      importPath: "/api/import/creator-csv",
      placeholder: "channelName,platform,email,country,tags,averageViews,fitScore",
    },
    pool: {
      title: "키 풀 CSV 일괄 등록",
      game: true,
      previewPath: "/api/import/key-pool/preview",
      importPath: "/api/import/key-pool",
      placeholder: "value,type,maxUses,label,note  (헤더 없이 키만 한 줄씩 붙여넣어도 됨)",
    },
  };
  let current = "keys";
  const fileEl = $("#csvModalFile");
  const textEl = $("#csvModalText");
  const gameSel = $("#csvModalGame");

  const bodyFor = () => {
    const body = { csvText: textEl.value };
    if (CONFIG[current].game) body.gameId = gameSel.value || selectedGameForForms();
    return body;
  };

  function open(type) {
    current = CONFIG[type] ? type : "keys";
    const cfg = CONFIG[current];
    $("#csvModalTitle").textContent = cfg.title;
    $("#csvModalGameWrap").style.display = cfg.game ? "" : "none";
    textEl.placeholder = cfg.placeholder;
    textEl.value = "";
    fileEl.value = "";
    $("#csvModalPreview").innerHTML = "";
    if (cfg.game) {
      // For the key pool, mirror the inline game selection (which must be chosen
      // explicitly); other game-scoped imports default to the dashboard scope.
      if (type === "pool") gameSel.value = $("#keyPoolGame")?.value || "";
      else if (state.selectedGameId !== "all") gameSel.value = state.selectedGameId;
    }
    modal.showModal();
  }

  async function preview() {
    try {
      const result = await api(CONFIG[current].previewPath, { method: "POST", body: bodyFor() });
      renderCsvModalPreview(result, current);
    } catch (error) {
      showToast(error.message);
    }
  }

  document.querySelectorAll("[data-open-csv]").forEach((btn) =>
    btn.addEventListener("click", () => open(btn.getAttribute("data-open-csv"))),
  );
  modal.querySelectorAll("[data-csv-close]").forEach((btn) => btn.addEventListener("click", () => modal.close()));

  fileEl.addEventListener("change", async () => {
    if (!fileEl.files?.length) return;
    const file = fileEl.files[0];
    try {
      let text = await file.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
      textEl.value = text;
      showToast(`${file.name} 불러왔습니다.`);
      await preview();
    } catch (error) {
      showToast(`파일을 읽지 못했습니다: ${error.message}`);
    } finally {
      fileEl.value = ""; // allow re-selecting the same file
    }
  });

  $("#csvModalPreviewBtn").addEventListener("click", preview);

  $("#csvModalImportBtn").addEventListener("click", async (event) => {
    if (!textEl.value.trim()) {
      showToast("CSV 내용이 비어 있습니다.");
      return;
    }
    // Game-scoped imports (keys / key pool): require an explicit game and confirm
    // it before writing — registering to the wrong game is painful to undo.
    if (CONFIG[current].game) {
      const gid = gameSel.value;
      if (!gid) {
        showToast("먼저 게임을 선택하세요.");
        gameSel.focus();
        return;
      }
      const lines = textEl.value.split(/[\r\n]+/).filter((s) => s.trim()).length;
      if (!confirm(`‘${gameName(gid)}’ 게임에 ${number(lines)}줄을 등록합니다.\n게임이 맞나요?`)) return;
    }
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const result = await api(CONFIG[current].importPath, { method: "POST", body: bodyFor() });
      showToast(`${number(result.imported)}개 추가, ${number(result.updated)}개 갱신`);
      modal.close();
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// Matrix cell editor: edit (or create) one creator's per-game record from the matrix.
let openMatrixCell = null;
function initMatrixModal() {
  const modal = $("#matrixCellModal");
  if (!modal) return;
  let ctx = { profileId: null, gameId: null, recordId: null };

  function openCell(profileId, gameId) {
    const profile = state.creatorProfiles.find((p) => p.id === profileId);
    const game = state.games.find((g) => g.id === gameId);
    const rec = state.creators.find((c) => c.creatorProfileId === profileId && c.gameId === gameId);
    ctx = { profileId, gameId, recordId: rec?.id || null, keyPoolId: rec?.keyPoolId || "" };
    $("#matrixModalTitle").textContent = `${profile?.channelName || "크리에이터"} · ${game?.name || "게임"}`;
    $("#matrixStatus").value = rec?.status || "uncontacted";
    $("#matrixKey").value = rec?.steamKey || "";
    // A pool-assigned key is managed by the pool — show it read-only (회수 to switch to manual).
    $("#matrixKey").readOnly = Boolean(rec?.keyPoolId);
    $("#matrixKeyCopy").hidden = !rec?.steamKey;
    $("#matrixSentAt").value = rec?.sentAt || "";
    $("#matrixEmbargo").value = rec?.embargoAt || "";
    $("#matrixNote").value = rec?.note || "";
    const a = rec?.steamActivation;
    $("#matrixUsed").value = a ? (a.activated ? "true" : "false") : "";
    $("#matrixUsage").textContent = a
      ? `사용여부: ${a.activated ? `사용됨${a.account ? ` (${a.account})` : ""}` : "미사용"} · ${a.source === "manual" ? "수동" : "확인"} ${formatDateTime(a.checkedAt)}`
      : "사용여부: 미확인";
    $("#matrixDeleteBtn").hidden = !rec;
    $("#matrixCheckBtn").disabled = !rec?.steamKeyMasked;
    // Key-pool assignment controls.
    const poolKeys = state.keyPool.filter((e) => e.gameId === gameId);
    const pickable = poolKeys.filter((e) => e.available || e.id === rec?.keyPoolId);
    $("#matrixPoolSelect").innerHTML =
      '<option value="">— 풀 키 선택 —</option>' +
      pickable
        .map(
          (e) =>
            `<option value="${escapeHtml(e.id)}"${e.id === rec?.keyPoolId ? " selected" : ""}>${escapeHtml(e.masked)} · ${escapeHtml(poolTypeLabel(e))} · ${e.assignedCount}/${e.maxUses == null ? "∞" : e.maxUses}</option>`,
        )
        .join("");
    const remaining = poolKeys.filter((e) => e.available).length;
    $("#matrixPoolRemaining").textContent = poolKeys.length
      ? `풀 잔여 ${remaining}개 / 전체 ${poolKeys.length}개`
      : "이 게임의 풀에 키가 없습니다 (배포·링크 탭에서 등록).";
    $("#matrixUnassignBtn").hidden = !rec?.keyPoolId;
    if (!modal.open) modal.showModal();
  }

  openMatrixCell = openCell; // expose so the per-game table's 편집 button can reuse this editor

  // Assigning a pool key needs a creator record to attach to — create one on demand.
  async function ensureMatrixRecord() {
    if (ctx.recordId) return ctx.recordId;
    const profile = state.creatorProfiles.find((p) => p.id === ctx.profileId);
    const created = await api("/api/creators", {
      method: "POST",
      body: {
        gameId: ctx.gameId,
        creatorProfileId: ctx.profileId,
        channelName: profile?.channelName || "",
        email: profile?.email || "",
        country: profile?.country || "",
        platform: profile?.platform || "",
      },
    });
    ctx.recordId = created.id;
    return created.id;
  }

  async function assignPoolKey(keyPoolId) {
    const id = await ensureMatrixRecord();
    await api(`/api/creators/${encodeURIComponent(id)}/assign-key`, { method: "POST", body: keyPoolId ? { keyPoolId } : {} });
    showToast("키를 배정했습니다.");
    await loadAll();
    openCell(ctx.profileId, ctx.gameId);
  }

  $("#matrixAutoAssignBtn")?.addEventListener("click", async () => {
    try {
      await assignPoolKey("");
    } catch (error) {
      showToast(error.message);
    }
  });
  $("#matrixPoolSelect")?.addEventListener("change", async (event) => {
    const keyPoolId = event.target.value;
    if (!keyPoolId) return;
    try {
      await assignPoolKey(keyPoolId);
    } catch (error) {
      showToast(error.message);
      openCell(ctx.profileId, ctx.gameId);
    }
  });
  $("#matrixUnassignBtn")?.addEventListener("click", async () => {
    if (!ctx.recordId) return;
    try {
      await api(`/api/creators/${encodeURIComponent(ctx.recordId)}/unassign-key`, { method: "POST", body: {} });
      showToast("키를 회수했습니다.");
      await loadAll();
      openCell(ctx.profileId, ctx.gameId);
    } catch (error) {
      showToast(error.message);
    }
  });

  $("#creatorMatrixWrap").addEventListener("click", async (event) => {
    // Click an email to copy it to the clipboard.
    const copyEl = event.target.closest("[data-copy]");
    if (copyEl) {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(copyEl.getAttribute("data-copy"));
        showToast("클립보드에 복사했습니다.");
      } catch {
        showToast("복사 실패 — 직접 선택해 복사하세요.");
      }
      return;
    }
    // Quick "메일" shortcut on uncontacted cells: open the dedicated mail composer.
    const mailBtn = event.target.closest("[data-matrix-mail]");
    if (mailBtn) {
      event.stopPropagation();
      const [profileId, gameId] = mailBtn.getAttribute("data-matrix-mail").split("|");
      if (openMailModal) openMailModal(profileId, gameId);
      return;
    }
    // Click the 📝 note chip: open the cell editor focused on the memo field.
    const noteChip = event.target.closest("[data-matrix-note]");
    if (noteChip) {
      const c = noteChip.closest("[data-matrix-profile]");
      if (c) {
        openCell(c.getAttribute("data-matrix-profile"), c.getAttribute("data-matrix-game"));
        $("#matrixNote")?.focus();
      }
      return;
    }
    if (event.target.closest("[data-edit-profile], [data-del-profile]")) return; // handled elsewhere
    // Open the editor only when the status badge is clicked — clicking empty cell
    // space no longer triggers the modal, so it won't fight with the icons.
    const badge = event.target.closest(".matrix-badge");
    if (!badge) return;
    const cell = badge.closest("[data-matrix-profile]");
    if (cell) openCell(cell.getAttribute("data-matrix-profile"), cell.getAttribute("data-matrix-game"));
  });

  modal.querySelectorAll("[data-matrix-close]").forEach((b) => b.addEventListener("click", () => modal.close()));

  $("#matrixSaveBtn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const profile = state.creatorProfiles.find((p) => p.id === ctx.profileId);
      const body = {
        status: $("#matrixStatus").value,
        sentAt: $("#matrixSentAt").value,
        embargoAt: $("#matrixEmbargo").value,
        note: $("#matrixNote").value,
      };
      // Only send a manual key when no pool key is assigned — otherwise saving would
      // detach the pool assignment. (Use 회수 to switch back to manual entry.)
      if (!ctx.keyPoolId) body.steamKey = $("#matrixKey").value.trim();
      const used = $("#matrixUsed").value; // "" = 자동, "true"/"false" = 수동 사용여부
      if (used !== "") body.activated = used === "true";
      if (ctx.recordId) {
        await api(`/api/creators/${encodeURIComponent(ctx.recordId)}`, { method: "PUT", body });
      } else {
        await api("/api/creators", {
          method: "POST",
          body: {
            ...body,
            gameId: ctx.gameId,
            creatorProfileId: ctx.profileId,
            channelName: profile?.channelName || "",
            email: profile?.email || "",
            country: profile?.country || "",
            platform: profile?.platform || "",
          },
        });
      }
      showToast("저장했습니다.");
      modal.close();
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#matrixCheckBtn").addEventListener("click", async (event) => {
    if (!ctx.recordId) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await api(`/api/creators/${encodeURIComponent(ctx.recordId)}/check-activation`, { method: "POST" });
      showToast("사용여부를 확인했습니다.");
      await loadAll();
      openCell(ctx.profileId, ctx.gameId); // refresh displayed usage
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#matrixKeyCopy").addEventListener("click", async () => {
    const value = $("#matrixKey").value.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast("코드를 복사했습니다.");
    } catch {
      showToast("복사 실패 — 직접 선택해 복사하세요.");
    }
  });

  $("#matrixDeleteBtn").addEventListener("click", async () => {
    if (!ctx.recordId) return;
    if (!confirm("이 게임의 기록을 삭제할까요?")) return;
    try {
      await api(`/api/creators/${encodeURIComponent(ctx.recordId)}`, { method: "DELETE" });
      showToast("삭제했습니다.");
      modal.close();
      await loadAll();
    } catch (error) {
      showToast(error.message);
    }
  });
}

// Email template manager modal (list + bilingual editor).
function initTemplateManager() {
  const modal = $("#templateModal");
  if (!modal) return;
  const form = $("#templateForm");

  function renderList() {
    const list = state.emailTemplates || [];
    $("#templateList").innerHTML = list.length
      ? list
          .map(
            (t) => `
        <div class="tmpl-item${state.editingTemplateId === t.id ? " active" : ""}">
          <button type="button" class="tmpl-pick" data-tmpl-edit="${escapeHtml(t.id)}">
            <span class="tmpl-name">${escapeHtml(t.name)}</span>
            ${t.builtin ? '<span class="tmpl-badge">기본</span>' : ""}
          </button>
          <button type="button" class="icon-btn" data-tmpl-edit="${escapeHtml(t.id)}" title="편집" aria-label="편집">${ICON_EDIT}</button>
          <button type="button" class="icon-btn danger" data-tmpl-del="${escapeHtml(t.id)}" title="삭제" aria-label="삭제">${ICON_TRASH}</button>
        </div>`,
          )
          .join("")
      : '<div class="empty" style="padding:12px">템플릿이 없습니다.</div>';
  }
  function setMultilang(show) {
    const cb = $("#tmplMultilang");
    const box = $("#tmplExtraLangs");
    if (cb) cb.checked = show;
    if (box) box.hidden = !show;
  }
  const BODY_FIELDS = ["bodyEn", "bodyKo", "bodyJa", "bodyDe", "bodyZh"];
  const bodyEditor = (name) => form.querySelector(`.rich-editor[data-name="${name}"]`);
  function resetForm() {
    form.reset();
    BODY_FIELDS.forEach((n) => {
      const ed = bodyEditor(n);
      if (ed) ed.innerHTML = "";
    });
    setMultilang(false);
    form.elements.id.value = "";
    state.editingTemplateId = null;
    $("#templateFormTitle").textContent = "새 템플릿";
    $("#templateSubmit").textContent = "추가";
    renderList();
  }
  function fillForm(t) {
    form.elements.id.value = t.id;
    form.elements.name.value = t.name || "";
    form.elements.subjectEn.value = t.subjectEn || "";
    setRich(bodyEditor("bodyEn"), t.bodyEn);
    form.elements.subjectKo.value = t.subjectKo || "";
    setRich(bodyEditor("bodyKo"), t.bodyKo);
    form.elements.subjectJa.value = t.subjectJa || "";
    setRich(bodyEditor("bodyJa"), t.bodyJa);
    form.elements.subjectDe.value = t.subjectDe || "";
    setRich(bodyEditor("bodyDe"), t.bodyDe);
    form.elements.subjectZh.value = t.subjectZh || "";
    setRich(bodyEditor("bodyZh"), t.bodyZh);
    setMultilang(Boolean(t.subjectJa || t.bodyJa || t.subjectDe || t.bodyDe || t.subjectZh || t.bodyZh));
    state.editingTemplateId = t.id;
    $("#templateFormTitle").textContent = `편집 중 · ${t.name}`;
    $("#templateSubmit").textContent = "수정 저장";
    renderList();
    form.scrollIntoView({ block: "nearest" });
  }

  $("#openTemplatesBtn")?.addEventListener("click", () => {
    renderList();
    resetForm();
    modal.showModal();
  });
  modal.querySelectorAll("[data-tmpl-close]").forEach((b) => b.addEventListener("click", () => modal.close()));
  $("#templateNewBtn").addEventListener("click", resetForm);
  $("#tmplMultilang")?.addEventListener("change", (event) => setMultilang(event.target.checked));

  $("#templateList").addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-tmpl-edit]");
    if (editBtn) {
      const t = state.emailTemplates.find((x) => x.id === editBtn.dataset.tmplEdit);
      if (t) fillForm(t);
      return;
    }
    const delBtn = event.target.closest("[data-tmpl-del]");
    if (delBtn) {
      const t = state.emailTemplates.find((x) => x.id === delBtn.dataset.tmplDel);
      if (!t || !confirm(`'${t.name}' 템플릿을 삭제할까요?`)) return;
      try {
        await api(`/api/email-templates/${encodeURIComponent(t.id)}`, { method: "DELETE" });
        showToast("삭제했습니다.");
        if (form.elements.id.value === t.id) resetForm();
        await loadAll();
        renderList();
      } catch (error) {
        showToast(error.message);
      }
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(form);
    BODY_FIELDS.forEach((n) => (data[n] = getRich(bodyEditor(n))));
    const id = String(data.id || "").trim();
    const submit = $("#templateSubmit");
    submit.disabled = true;
    try {
      if (id) {
        await api(`/api/email-templates/${encodeURIComponent(id)}`, { method: "PUT", body: data });
        showToast("템플릿을 수정했습니다.");
      } else {
        await api("/api/email-templates", { method: "POST", body: data });
        showToast("템플릿을 추가했습니다.");
        resetForm();
      }
      await loadAll();
      renderList();
    } catch (error) {
      showToast(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  $("#tmplAiGenerate")?.addEventListener("click", async () => {
    const briefEl = $("#tmplAiBrief");
    const statusEl = $("#tmplAiStatus");
    const btn = $("#tmplAiGenerate");
    const brief = (briefEl?.value || "").trim();
    if (!brief) {
      showToast("AI에 전달할 설명을 입력하세요.");
      briefEl?.focus();
      return;
    }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "생성 중…";
    if (statusEl) statusEl.textContent = "Gemma 4가 초안을 작성 중…";
    try {
      const gameId = state.selectedGameId && state.selectedGameId !== "all" ? state.selectedGameId : "";
      const draft = await api("/api/email-templates/generate", { method: "POST", body: { brief, gameId } });
      // Populate the form as a NEW draft (no id) so the user reviews and saves
      // it via the existing "추가" button.
      form.elements.id.value = "";
      state.editingTemplateId = null;
      form.elements.name.value = draft.name || "";
      form.elements.subjectEn.value = draft.subjectEn || "";
      setRich(bodyEditor("bodyEn"), draft.bodyEn);
      form.elements.subjectKo.value = draft.subjectKo || "";
      setRich(bodyEditor("bodyKo"), draft.bodyKo);
      $("#templateFormTitle").textContent = "AI 초안 · 검토 후 추가";
      $("#templateSubmit").textContent = "추가";
      renderList();
      if (statusEl) statusEl.textContent = "초안 생성됨 — 내용 확인 후 ‘추가’를 눌러 저장하세요.";
      showToast("AI 초안을 생성했습니다.");
    } catch (error) {
      if (statusEl) statusEl.textContent = "";
      showToast(error.message || "AI 생성에 실패했습니다.");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

function initForms() {
  bindForm("#gameForm", (data) =>
    api("/api/games", {
      method: "POST",
      body: data,
    }),
  );

  bindForm("#gameSettingsForm", (data) =>
    api(`/api/games/${encodeURIComponent(data.gameId)}`, {
      method: "PUT",
      body: data,
    }),
  );

  initImagePicker($("#gameForm"));
  initImagePicker($("#gameSettingsForm"));

  bindForm("#storeListingForm", (data) =>
    api("/api/store-listings", {
      method: "POST",
      body: data,
    }),
  );

  bindForm("#campaignForm", (data) =>
    api("/api/campaigns", {
      method: "POST",
      body: withSelectedGame(data),
    }),
  );

  // Creator profile add/edit lives in a compact modal; one form handles both (hidden id).
  const profileModal = $("#profileModal");
  const profileForm = $("#creatorProfileForm");
  function openProfileModal(profile) {
    profileForm.reset();
    profileForm.elements.id.value = profile?.id || "";
    profileForm.elements.channelName.value = profile?.channelName || "";
    profileForm.elements.links.value = (profile?.channels || []).map((c) => c.url).join("\n");
    profileForm.elements.email.value = profile?.email || "";
    profileForm.elements.country.value = profile?.country || "";
    profileForm.elements.tags.value = (profile?.tags || []).join(", ");
    const platforms = new Set(profile?.gamePlatforms || []);
    profileForm.querySelectorAll('input[name="gamePlatforms"]').forEach((el) => {
      el.checked = platforms.has(el.value);
    });
    profileForm.elements.averageViews.value = profile?.averageViews || "";
    profileForm.elements.fitScore.value = profile?.fitScore || "";
    $("#profileModalTitle").textContent = profile ? "크리에이터 편집" : "크리에이터 추가";
    $("#creatorProfileSubmit").textContent = profile ? "수정 저장" : "추가";
    profileModal.showModal();
  }
  $("#openProfileAddBtn")?.addEventListener("click", () => openProfileModal(null));
  profileModal?.querySelectorAll("[data-profile-close]").forEach((b) => b.addEventListener("click", () => profileModal.close()));

  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("#creatorProfileSubmit");
    submit.disabled = true;
    try {
      const data = formData(profileForm);
      // Checkboxes share the name "gamePlatforms" → collect them explicitly
      // (formData/Object.fromEntries would keep only one).
      data.gamePlatforms = [...profileForm.querySelectorAll('input[name="gamePlatforms"]:checked')].map((el) => el.value);
      const id = String(data.id || "").trim();
      if (id) {
        await api(`/api/creator-profiles/${encodeURIComponent(id)}`, { method: "PUT", body: data });
        showToast("크리에이터를 수정했습니다.");
      } else {
        await api("/api/creator-profiles", { method: "POST", body: data });
        showToast("크리에이터를 추가했습니다.");
      }
      profileModal.close();
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  // Row 편집/삭제 buttons live in the matrix table now.
  $("#creatorMatrixWrap").addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-profile]");
    if (editBtn) {
      const p = state.creatorProfiles.find((x) => x.id === editBtn.dataset.editProfile);
      if (p) openProfileModal(p);
      return;
    }
    const delBtn = event.target.closest("[data-del-profile]");
    if (delBtn) {
      const p = state.creatorProfiles.find((x) => x.id === delBtn.dataset.delProfile);
      if (!p) return;
      if (!confirm(`'${p.channelName}' 크리에이터를 삭제할까요? (게임별 키/상태 기록은 남습니다)`)) return;
      try {
        await api(`/api/creator-profiles/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        showToast("삭제했습니다.");
        await loadAll();
      } catch (error) {
        showToast(error.message);
      }
    }
  });

  initRichEditors();
  initCsvImportModal();
  initMatrixModal();
  initMailModal();
  initTemplateManager();

  // Creator sort.
  $("#matrixSort")?.addEventListener("change", (event) => {
    state.matrixSort = event.target.value;
    renderCreatorMatrix();
  });
  // Filter creators by game platform (VR / PC).
  $("#matrixPlatformFilter")?.addEventListener("change", (event) => {
    state.platformFilter = event.target.value;
    renderCreatorMatrix();
  });

  // Game-column visibility filter.
  $("#matrixGameFilter").addEventListener("change", (event) => {
    const box = event.target.closest("[data-game-toggle]");
    if (!box) return;
    const id = box.getAttribute("data-game-toggle");
    if (box.checked) state.hiddenGames.delete(id);
    else state.hiddenGames.add(id);
    renderCreatorMatrix();
  });
  $("#matrixGameFilter").addEventListener("click", (event) => {
    const allGames = state.games.filter((g) => !g.archived);
    if (event.target.closest("#matrixGameAll")) {
      state.hiddenGames.clear();
      renderCreatorMatrix();
    } else if (event.target.closest("#matrixGameNone")) {
      state.hiddenGames = new Set(allGames.map((g) => g.id));
      renderCreatorMatrix();
    }
  });

  $("#creatorRefreshAll").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "조회 중…";
    try {
      const result = await api("/api/creators/check-activation", {
        method: "POST",
        body: { gameId: "all" },
      });
      if (result.authError) {
        showToast(result.message || "Steam 파트너 세션 쿠키를 확인하세요.");
      } else {
        showToast(`${number(result.checked)}개 조회 · ${number(result.activated)}개 사용됨`);
      }
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  bindForm("#redditPostForm", (data) =>
    api("/api/reddit-posts", {
      method: "POST",
      body: data,
    }),
  );

  // Paste a Reddit URL → immediately fetch + pre-fill the form (title/sub/date).
  const redditForm = $("#redditPostForm");
  const redditUrlInput = redditForm?.elements?.url;
  if (redditUrlInput) {
    let redditAutofillTimer = 0;
    const runAutofill = async () => {
      const url = String(redditUrlInput.value || "").trim();
      if (!url || !/reddit\.com\/.+\/comments\/|redd\.it\//i.test(url)) return;
      if (redditForm.dataset.autofilledUrl === url) return; // don't refetch the same URL
      redditForm.dataset.autofilledUrl = url;
      try {
        const r = await api("/api/reddit-posts/preview", { method: "POST", body: { url } });
        if (!r.found) {
          if (r.warning) showToast(r.warning);
          return;
        }
        const fill = (name, val) => {
          const el = redditForm.elements[name];
          if (el && !el.value && val) el.value = val;
        };
        fill("subreddit", r.subreddit);
        fill("title", r.title);
        fill("postedAt", r.postedAt);
        // gemma-suggested game → preselect the dropdown if it's still empty.
        const gameSel = redditForm.elements.gameId;
        if (r.suggestedGameId && gameSel && !gameSel.value) gameSel.value = r.suggestedGameId;
        const gameNote = r.suggestedGameName ? ` · 게임: ${r.suggestedGameName}` : "";
        const viewNote = typeof r.views === "number" ? ` · 조회 ${number(r.views)}` : "";
        showToast(`불러옴: ${r.title || r.subreddit || r.postId}${viewNote} · 업보트 ${number(r.upvotes)} · 댓글 ${number(r.comments)}${gameNote}`);
      } catch (error) {
        showToast(error.message);
      }
    };
    redditUrlInput.addEventListener("input", () => {
      window.clearTimeout(redditAutofillTimer);
      redditAutofillTimer = window.setTimeout(runAutofill, 500);
    });
    redditUrlInput.addEventListener("change", runAutofill);
  }

  bindForm(
    "#csvForm",
    async (data, form) => {
      const result = await api("/api/import/steam-csv", {
        method: "POST",
        body: { csvText: data.csvText, gameId: selectedGameForForms() },
      });
      showToast(`${result.imported}개 추가, ${result.replaced}개 교체`);
      form.querySelector("textarea").value = data.csvText;
    },
    { keepValues: true },
  );

  bindForm(
    "#syncScheduleForm",
    (data, form) =>
      api("/api/sync-schedule", {
        method: "PUT",
        body: {
          ...data,
          includeWishlist: form.elements.includeWishlist.checked,
          includeSales: form.elements.includeSales.checked,
        },
      }),
    { keepValues: true },
  );

  bindForm(
    "#steamSettingsForm",
    (data, form) =>
      api("/api/settings", {
        method: "PUT",
        body: {
          steamFinancialApiKey: data.steamFinancialApiKey,
          clearSteamFinancialApiKey: form.elements.clearSteamFinancialApiKey.checked,
          steamPartnerCookie: data.steamPartnerCookie,
          clearSteamPartnerCookie: form.elements.clearSteamPartnerCookie?.checked,
        },
      }),
    { keepValues: true },
  );

  bindForm(
    "#emailSettingsForm",
    (data, form) =>
      api("/api/settings", {
        method: "PUT",
        body: {
          ...data,
          smtpSecure: data.smtpSecure === "true",
          smtpStarttls: data.smtpStarttls === "true",
          clearSmtpPass: form.elements.clearSmtpPass.checked,
          clearGraphClientSecret: form.elements.clearGraphClientSecret.checked,
        },
      }),
    { keepValues: true },
  );
  $("#emailSendModeSelect")?.addEventListener("change", (event) => {
    toggleEmailModeFields(event.currentTarget.form);
  });

  $("#csvPreviewButton").addEventListener("click", async () => {
    try {
      const data = formData($("#csvForm"));
      const preview = await api("/api/import/steam-csv/preview", {
        method: "POST",
        body: { csvText: data.csvText, gameId: selectedGameForForms() },
      });
      renderCsvPreview(preview);
      showToast("CSV 미리보기를 만들었습니다.");
    } catch (error) {
      showToast(error.message);
    }
  });

  $("#utmForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/utm-links", {
        method: "POST",
        body: withSelectedGame(formData(event.currentTarget)),
      });
      $("#utmResult").innerHTML = `<a href="${escapeHtml(result.link)}" target="_blank" rel="noreferrer">${escapeHtml(result.link)}</a>`;
      showToast("UTM 링크를 생성했습니다.");
    } catch (error) {
      showToast(error.message);
    }
  });

  // ---- Key pool (distribution tab) ----
  bindForm("#keyPoolForm", (data) => {
    const gameId = $("#keyPoolGame")?.value || "";
    if (!gameId) throw new Error("먼저 게임을 선택하세요.");
    const raw = data.type; // single | multi | multi-unlimited
    const type = raw === "single" ? "single" : "multi";
    const maxUses = raw === "multi" ? data.maxUses : ""; // single/unlimited → no cap
    return api("/api/key-pool", {
      method: "POST",
      body: { value: data.value, type, maxUses, label: data.label, note: data.note, gameId },
    });
  });
  $("#keyPoolType")?.addEventListener("change", (event) => {
    $("#keyPoolMaxWrap").hidden = event.target.value !== "multi";
  });

  // Bulk paste → register each line as a single-use key.
  const bulkForm = $("#keyPoolBulkForm");
  const bulkKeys = bulkForm?.elements?.keys;
  const countKeys = (txt) => String(txt || "").split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean).length;
  bulkKeys?.addEventListener("input", () => {
    $("#keyPoolBulkCount").textContent = `${countKeys(bulkKeys.value)}개 감지`;
  });
  bulkForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = String(bulkKeys.value || "").trim();
    const gameId = $("#keyPoolGame")?.value || "";
    if (!gameId) return showToast("먼저 게임을 선택하세요.");
    if (!text) return showToast("키를 붙여넣어 주세요.");
    if (!confirm(`‘${gameName(gameId)}’ 게임에 키 ${countKeys(text)}개를 등록합니다.\n게임이 맞나요?`)) return;
    const btn = bulkForm.querySelector("button[type='submit']");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "등록 중…";
    try {
      const r = await api("/api/import/key-pool", { method: "POST", body: { csvText: text, gameId } });
      showToast(`키 ${r.imported}개 등록 (1회용)${r.skippedDuplicates ? ` · 중복 ${r.skippedDuplicates}개 건너뜀` : ""} · 총 ${r.totalRows}줄`);
      bulkForm.reset();
      $("#keyPoolBulkCount").textContent = "0개 감지";
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  $("#keyPoolForm")?.addEventListener("reset", () => {
    $("#keyPoolMaxWrap").hidden = true;
  });
  $("#keyPoolGame")?.addEventListener("change", renderKeyPool);
  $("#keyPoolTableWrap")?.addEventListener("click", async (event) => {
    const copyEl = event.target.closest("[data-copy]");
    if (copyEl) {
      try {
        await navigator.clipboard.writeText(copyEl.getAttribute("data-copy"));
        showToast("클립보드에 복사했습니다.");
      } catch {
        showToast("복사 실패 — 직접 선택해 복사하세요.");
      }
      return;
    }
    const del = event.target.closest("[data-del-pool]");
    if (del) {
      const id = del.getAttribute("data-del-pool");
      const entry = state.keyPool.find((e) => e.id === id);
      const assigned = entry?.assignedCount || 0;
      if (assigned > 0 && !confirm(`${assigned}명에게 배정된 키입니다. 회수하고 삭제할까요?`)) return;
      try {
        await api(`/api/key-pool/${encodeURIComponent(id)}${assigned > 0 ? "?force=1" : ""}`, { method: "DELETE" });
        showToast("키를 삭제했습니다.");
        await loadAll();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
  });

  $("#syncForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    submitter.disabled = true;
    try {
      const form = event.currentTarget;
      const data = formData(form);
      const result = await api("/api/steam-sync/run", {
        method: "POST",
        body: {
          gameId: data.gameId || "all",
          startDate: data.startDate,
          endDate: data.endDate,
          includeWishlist: form.elements.includeWishlist.checked,
          includeSales: form.elements.includeSales.checked,
          dryRun: submitter.value !== "false",
        },
      });
      state.syncStatus = result.status;
      state.dashboard = result.dashboard;
      await loadAll();
      showToast(result.run.warnings?.[0] || `동기화 ${result.run.status}`);
    } catch (error) {
      showToast(error.message);
    } finally {
      submitter.disabled = false;
    }
  });

  $("#gameFilter").addEventListener("change", async (event) => {
    await setGameScope(event.currentTarget.value);
  });

  $("#settingsGameSelect").addEventListener("change", (event) => {
    populateGameSettingsForm(event.currentTarget.value);
  });

  $("#storeListingTable").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-archive-listing-id]");
    if (!button) return;
    if (button.dataset.listingSteam === "1" && !window.confirm("이 Steam 리스팅을 삭제하면 게임의 Steam App ID 연결도 해제됩니다. 계속할까요?")) {
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/store-listings/${encodeURIComponent(button.dataset.archiveListingId)}`, {
        method: "DELETE",
      });
      await loadAll();
      showToast("스토어 리스팅을 삭제했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#runScheduleNowButton").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const result = await api("/api/sync-schedule/run-due", {
        method: "POST",
        body: { force: true },
      });
      await loadAll();
      showToast(result.run?.warnings?.[0] || result.reason || result.run?.status || "스케줄을 실행했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#syncRunTable").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-sync-run-id]");
    if (!button) return;
    button.disabled = true;
    try {
      const run = await api(`/api/steam-sync/runs/${encodeURIComponent(button.dataset.syncRunId)}`);
      renderSyncRunDetail(run);
      showToast("동기화 상세를 불러왔습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#data").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-export-type]");
    if (!button) return;
    button.disabled = true;
    try {
      const type = button.dataset.exportType;
      const data = await api(`/api/export?type=${encodeURIComponent(type)}`);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(`overay-desk-${type}-${stamp}.json`, data);
      $("#exportResult").textContent = `${type} export 생성 완료`;
      showToast("내보내기를 만들었습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#youtubeConfigPanel")?.addEventListener("toggle", (event) => {
    event.currentTarget.dataset.touched = "1";
  });

  $("#youtubeRevealButton")?.addEventListener("click", (event) => {
    const btn = event.currentTarget;
    const info = $("#youtubeCredInfo");
    if (!info) return;
    if (!info.hasAttribute("hidden")) {
      info.setAttribute("hidden", "");
      btn.textContent = "등록 정보 확인";
      return;
    }
    const yt = state.youtube || {};
    const oauth = yt.oauth || {};
    info.innerHTML = `<div class="settings-state-list">
      <div class="settings-state-item"><span>Data API Key</span><strong>${yt.keyMasked ? escapeHtml(yt.keyMasked) : "미등록"}</strong><small>${yt.configured ? "등록됨" : "없음"}</small></div>
      <div class="settings-state-item"><span>OAuth Client ID</span><strong>${oauth.clientId ? escapeHtml(oauth.clientId) : "미등록"}</strong><small>${oauth.clientId ? "등록됨" : "없음"}</small></div>
      <div class="settings-state-item"><span>OAuth Client Secret</span><strong>${oauth.clientSecretMasked ? escapeHtml(oauth.clientSecretMasked) : "미등록"}</strong><small>${oauth.clientSecretMasked ? "등록됨" : "없음"}</small></div>
      <div class="settings-state-item"><span>Google 연결</span><strong>${oauth.connected ? "연결됨" : "미연결"}</strong><small>${oauth.connected && oauth.connectedAt ? escapeHtml(new Date(oauth.connectedAt).toLocaleString("ko-KR")) : ""}</small></div>
    </div>`;
    info.removeAttribute("hidden");
    btn.textContent = "확인 숨기기";
  });

  $("#youtubeKeyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = form.querySelector("button[type='submit']");
    submitter.disabled = true;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          youtubeApiKey: form.elements.youtubeApiKey.value,
          clearYoutubeApiKey: form.elements.clearYoutubeApiKey.checked,
        },
      });
      form.elements.youtubeApiKey.value = "";
      form.elements.clearYoutubeApiKey.checked = false;
      await loadAll();
      showToast("YouTube API 키를 저장했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      submitter.disabled = false;
    }
  });

  $("#youtubeChannelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = form.querySelector("button[type='submit']");
    submitter.disabled = true;
    try {
      const channel = await api("/api/youtube/channels", {
        method: "POST",
        body: { channelId: form.elements.channelId.value },
      });
      if (state.youtube) state.youtube.selectedChannelId = channel.id;
      form.reset();
      await loadAll();
      showToast(`채널을 추가했습니다: ${channel.title || channel.channelId}`);
    } catch (error) {
      showToast(error.message);
    } finally {
      submitter.disabled = false;
    }
  });

  $("#youtubeSyncButton").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const result = await api("/api/youtube/sync", { method: "POST", body: {} });
      await loadAll();
      showToast(result.warnings?.length ? result.warnings[0] : `동기화 완료 · 채널 ${result.synced}개`);
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#youtubeChannelTabs").addEventListener("click", async (event) => {
    const del = event.target.closest("[data-yt-del]");
    if (del) {
      if (!window.confirm("이 채널을 목록에서 삭제할까요?")) return;
      try {
        await api(`/api/youtube/channels/${encodeURIComponent(del.dataset.ytDel)}`, { method: "DELETE" });
        await loadAll();
        showToast("채널을 삭제했습니다.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    const tab = event.target.closest("[data-yt-channel]");
    if (!tab) return;
    if (state.youtube) state.youtube.selectedChannelId = tab.dataset.ytChannel;
    renderYoutube();
  });

  $("#youtubeOAuthForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = form.querySelector("button[type='submit']");
    submitter.disabled = true;
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          youtubeClientId: form.elements.youtubeClientId.value,
          youtubeClientSecret: form.elements.youtubeClientSecret.value,
          clearYoutubeClientSecret: form.elements.clearYoutubeClientSecret.checked,
        },
      });
      form.elements.youtubeClientSecret.value = "";
      form.elements.clearYoutubeClientSecret.checked = false;
      await loadAll();
      showToast("OAuth 설정을 저장했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      submitter.disabled = false;
    }
  });

  $("#youtubeOAuthStatus").addEventListener("click", async (event) => {
    if (event.target.closest("#youtubeConnectButton")) {
      window.location.href = "/api/youtube/oauth/start";
      return;
    }
    if (event.target.closest("#youtubeDisconnectButton")) {
      if (!window.confirm("Google 계정 연결을 해제할까요? (저장된 채널과 공개 지표는 유지됩니다)")) return;
      try {
        await api("/api/youtube/oauth/disconnect", { method: "POST", body: {} });
        if (state.youtube) {
          state.youtube.analytics = null;
          state.youtube.analyticsKey = "";
        }
        await loadAll();
        showToast("Google 연결을 해제했습니다.");
      } catch (error) {
        showToast(error.message);
      }
    }
  });

  $("#youtubeAnalytics").addEventListener("click", (event) => {
    const dayButton = event.target.closest("[data-yt-days]");
    if (dayButton) {
      if (state.youtube) state.youtube.selectedDays = Number(dayButton.dataset.ytDays) || 28;
      renderYoutube();
      return;
    }
    if (event.target.closest("[data-yt-refresh]")) {
      if (state.youtube) state.youtube.analyticsKey = "";
      renderYoutube();
    }
  });

  $("#outreachLogDownload")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "준비 중…";
    try {
      // days=0 → all logs (server's default is the last 30 days for the table).
      const logs = await api(`/api/outreach-logs?gameId=${encodeURIComponent(state.selectedGameId)}&days=0`);
      if (!logs.length) {
        showToast("다운로드할 로그가 없습니다.");
        return;
      }
      downloadCsv(`outreach-logs-${localDateString()}.csv`, logs, [
        { label: "시간", get: (l) => l.createdAt },
        { label: "상태", get: (l) => l.status },
        { label: "크리에이터", get: (l) => l.creatorName || l.to || "" },
        { label: "게임", get: (l) => l.gameName || "" },
        { label: "캠페인", get: (l) => l.campaignName || "" },
        { label: "제목", get: (l) => l.subject || "" },
        { label: "수신", get: (l) => l.to || "" },
        { label: "provider", get: (l) => l.provider || "" },
        { label: "메시지", get: (l) => l.message || l.error || "" },
      ]);
      showToast(`전체 로그 ${number(logs.length)}개 CSV 다운로드`);
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $("#redditRefreshButton")?.addEventListener("click", (event) => {
    runRedditJob({
      startPath: "/api/reddit-posts/refresh",
      body: {},
      btn: event.currentTarget,
      busyText: "갱신 중… (사람처럼 천천히)",
    });
  });

  $("#redditImportMineButton")?.addEventListener("click", (event) => {
    runRedditJob({
      startPath: "/api/reddit-posts/import-mine",
      body: { max: 80 },
      btn: event.currentTarget,
      busyText: "불러오는 중… (사람처럼 천천히, 약 1분)",
    });
  });

  // Click the session line to re-verify the logged-in account live (headless visit).
  $("#redditSessionInfo")?.addEventListener("click", () => loadRedditSessionInfo({ refresh: true }));
  loadRedditSessionInfo();

  $("#redditTable")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-del-reddit]");
    if (!button) return;
    if (!window.confirm("이 레딧 글 기록을 삭제할까요?")) return;
    button.disabled = true;
    try {
      await api(`/api/reddit-posts/${encodeURIComponent(button.dataset.delReddit)}`, { method: "DELETE" });
      await loadAll();
      showToast("기록을 삭제했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#refreshButton").addEventListener("click", async () => {
    try {
      await loadAll();
      showToast("새로고침했습니다.");
    } catch (error) {
      showToast(error.message);
    }
  });
}

// ============================ Discovery bot ============================
const DISCOVERY_STATUS_LABELS = {
  never_run: "미실행",
  running: "실행 중",
  ok: "완료",
  error: "오류",
  quota: "할당량 초과",
  capped: "완료",
  stopped: "중지됨",
  discovered: "검수 대기",
  approved: "승인됨",
  dismissed: "제외됨",
};
function discoveryStatusLabel(value) {
  return DISCOVERY_STATUS_LABELS[value] || value || "-";
}

function formatDiscoveryElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s % 60}초`;
}

function getDiscoverySeeds() {
  const raw = $("#discoverySeeds")?.value || "";
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let discoveryPollTimer = 0;
let discoveryStopping = false;
let discoveryLastStatus = "";
let discoverySeenIds = null; // null = not yet initialized (avoid bubble flood on first paint)
function stopDiscoveryPolling() {
  if (discoveryPollTimer) {
    window.clearInterval(discoveryPollTimer);
    discoveryPollTimer = 0;
  }
}
function startDiscoveryPolling() {
  if (discoveryPollTimer) return;
  // Poll fast while a session runs so logs + progress feel live.
  discoveryPollTimer = window.setInterval(() => {
    loadDiscovery().catch(() => {});
  }, 2000);
}

async function loadDiscovery() {
  try {
    const data = await api("/api/discovery");
    if (data) state.discovery = data;
  } catch (error) {
    /* keep previous state on a transient failure */
  }
  renderDiscovery();
}

function renderDiscovery() {
  const d = state.discovery;
  if (!d) return;
  const st = d.state || {};
  const running = Boolean(st.running);
  const sources = d.sources || {};
  const anySource = sources.youtube || sources.twitch || sources.web;

  // Toast on a fresh error/quota result (status changed since last render).
  if ((st.lastStatus === "error" || st.lastStatus === "quota") && discoveryLastStatus !== st.lastStatus && st.lastMessage) {
    showToast(`찾아봇: ${st.lastMessage}`);
  }
  discoveryLastStatus = st.lastStatus;

  const runState = $("#discoveryRunState");
  if (runState) {
    const label = runState.querySelector(".discovery-runstate-label");
    const spinner = runState.querySelector(".discovery-spinner");
    if (label) {
      label.textContent = running
        ? "실행 중"
        : st.lastStatus === "never_run"
          ? "대기"
          : `마지막: ${discoveryStatusLabel(st.lastStatus)}`;
    }
    if (spinner) spinner.hidden = !running;
    runState.classList.toggle("running", running);
  }

  const srcLine = $("#discoverySourceLine");
  if (srcLine) {
    srcLine.textContent = [
      `YouTube ${sources.youtube ? "✓" : "✕"}`,
      `Twitch ${sources.twitch ? "✓" : "✕"}`,
      `Web ${sources.web ? "✓" : "✕"}`,
      `렌더 ${d.rendererEnabled ? "✓" : "✕"}`,
    ].join("  ·  ");
  }

  const winLine = $("#discoveryWindowLine");
  if (winLine && d.window) {
    winLine.textContent = `새벽 자동 구동 ${d.window.start}–${d.window.end} · ${d.schedulerEnabled ? "켜짐" : "꺼짐 (서버 환경변수로 활성화)"}`;
  }

  const grid = $("#discoveryStatusGrid");
  if (grid) {
    const stats = st.lastStats || {};
    // Live elapsed while running: prefer the wall-clock since startedAt.
    let elapsed = "-";
    if (running && st.startedAt) elapsed = formatDiscoveryElapsed(Date.now() - new Date(st.startedAt).getTime());
    else if (st.elapsedMs) elapsed = formatDiscoveryElapsed(st.elapsedMs);
    const rows = [
      ["상태", discoveryStatusLabel(st.lastStatus)],
      ["경과 시간", elapsed],
      ["검색 수행", numberFormat.format(stats.seedsSearched || 0)],
      ["분석", numberFormat.format(stats.analyzed || 0)],
      ["이메일 확보", numberFormat.format(stats.withEmail || 0)],
      ["종료 예정", running && st.endsAt ? new Date(st.endsAt).toLocaleTimeString("ko-KR") : "-"],
    ];
    grid.innerHTML = rows
      .map(([k, v]) => `<div class="sync-stat"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`)
      .join("");
  }

  const found = $("#discoverySessionFound");
  if (found) found.textContent = `누적 신규 ${numberFormat.format(st.sessionFound || 0)}명`;
  const progress = $("#discoveryProgress");
  if (progress) {
    progress.textContent = st.progress ? st.progress : st.lastMessage ? st.lastMessage : "";
    progress.classList.toggle("live", running);
  }

  renderDiscoveryLog(d.logs || []);
  renderDiscoveryStage(d, st, running);

  const stopBtn = $("#discoveryStop");
  if (stopBtn) {
    stopBtn.hidden = !running;
    if (!running) discoveryStopping = false;
    stopBtn.disabled = discoveryStopping;
    stopBtn.textContent = discoveryStopping ? "중지 중…" : "중지";
  }
  for (const btn of document.querySelectorAll("#discoveryQuickRun, [data-discovery-minutes]")) {
    btn.disabled = running || !anySource;
  }

  // Make the reason for any restriction visible (instead of just greying out buttons).
  const hint = $("#discoveryRunHint");
  if (hint) {
    let msg = "";
    let level = "warn";
    if (running) {
      msg = "세션이 실행 중이에요. 중지한 뒤 다시 실행할 수 있어요.";
      level = "info";
    } else if (!anySource) {
      msg = "⚠ 검색 소스가 없어 실행할 수 없어요. ‘게임 · 설정’ 탭에서 YouTube API 키를 등록하면 켜집니다.";
      level = "warn";
    } else if (st.lastStatus === "quota") {
      msg = "⚠ 오늘 YouTube 검색 할당량을 다 썼어요. 태평양시 자정(보통 오후 4~5시 KST) 리셋 후 다시 시도하세요. 지금 실행하면 바로 멈춥니다.";
      level = "warn";
    }
    hint.textContent = msg;
    hint.hidden = !msg;
    hint.dataset.level = level;
  }

  // Auto-manage the live poll: only while a session is running.
  if (running) startDiscoveryPolling();
  else stopDiscoveryPolling();

  renderDiscoveryQueue();
}

const DISCOVERY_IDLE_SPEECH = {
  never_run: "대기 중… 검색을 시작해 주세요",
  ok: "탐색 완료! 검수 큐를 확인하세요 ✨",
  capped: "탐색 완료! 검수 큐를 확인하세요 ✨",
  quota: "오늘 검색 할당량을 다 썼어요 😴 내일 또 찾을게요",
  stopped: "중지했어요. 언제든 다시 시작!",
  error: "앗, 문제가 생겼어요 — 로그를 확인해 주세요",
};

function spawnFindBubble(c) {
  const host = $("#stageBubbles");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "find-bubble";
  el.textContent = `✨ ${c.channelName || "새 채널"}`;
  el.style.marginLeft = `${-78 + Math.floor(Math.random() * 24 - 12)}px`;
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 2700);
}

// Drive the cute mascot stage: scanning state, speech, animated counter, and a
// "found!" bubble for each new creator that pops in during a live session.
function renderDiscoveryStage(d, st, running) {
  const stage = $("#discoveryStage");
  if (!stage) return;
  stage.dataset.running = running ? "true" : "false";

  const speech = $("#stageSpeech");
  if (speech) {
    speech.textContent = running ? st.progress || "탐색 중…" : DISCOVERY_IDLE_SPEECH[st.lastStatus] || "대기 중…";
  }

  const countEl = $("#stageCount");
  if (countEl) {
    const n = st.sessionFound || 0;
    const prev = Number(String(countEl.textContent).replace(/[^0-9]/g, "")) || 0;
    countEl.textContent = numberFormat.format(n);
    if (n > prev) {
      countEl.classList.remove("bump");
      void countEl.offsetWidth; // restart the animation
      countEl.classList.add("bump");
    }
  }

  // Pop a bubble for each newly discovered candidate — only during a live run,
  // and never on the first paint (would flood with the whole existing queue).
  const cands = d.candidates || [];
  const ids = cands.map((c) => c.id);
  if (discoverySeenIds === null) {
    discoverySeenIds = new Set(ids);
  } else {
    if (running) {
      cands
        .filter((c) => c.id && c.status === "discovered" && !discoverySeenIds.has(c.id))
        .slice(0, 2)
        .forEach((c) => spawnFindBubble(c));
    }
    ids.forEach((id) => discoverySeenIds.add(id));
  }
}

function renderDiscoveryLog(logs) {
  const panel = $("#discoveryLogPanel");
  if (!panel) return;
  const count = $("#discoveryLogCount");
  if (count) count.textContent = logs.length ? `${logs.length}줄` : "로그 없음";
  if (!logs.length) {
    panel.innerHTML = `<p class="discovery-empty">아직 로그가 없습니다. 검색을 실행하면 여기에 진행 상황이 실시간으로 표시됩니다.</p>`;
    return;
  }
  // Stick to bottom only if the user is already near the bottom (don't yank the
  // scroll while they're reading older lines).
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
  panel.innerHTML = logs
    .map((l) => {
      const t = l.at ? new Date(l.at).toLocaleTimeString("ko-KR", { hour12: false }) : "";
      return `<div class="log-line log-${escapeHtml(l.level || "info")}"><span class="log-time">${escapeHtml(t)}</span><span class="log-msg">${escapeHtml(l.msg || "")}</span></div>`;
    })
    .join("");
  if (atBottom) panel.scrollTop = panel.scrollHeight;
}

function discoveryPruneCriteria() {
  return {
    minSubs: Number($("#pruneMinSubs")?.value) || 0,
    dormantMonths: Number($("#pruneDormant")?.value) || 0,
  };
}
function discoveryPruneMatches(c, { minSubs, dormantMonths }) {
  if (c.status !== "discovered") return false;
  if (minSubs && (Number(c.subscribers) || 0) < minSubs) return true;
  if (dormantMonths && c.lastUploadAt && new Date(c.lastUploadAt).getTime() < Date.now() - dormantMonths * 30 * 86400000) return true;
  return false;
}
function refreshPrunePreview() {
  const el = $("#prunePreview");
  if (!el) return;
  const crit = discoveryPruneCriteria();
  const any = crit.minSubs || crit.dormantMonths;
  const n = any ? (state.discovery?.candidates || []).filter((c) => discoveryPruneMatches(c, crit)).length : 0;
  el.textContent = `대상 ${number(n)}명`;
}

function renderDiscoveryQueue() {
  const wrap = $("#discoveryQueueWrap");
  if (!wrap) return;
  refreshPrunePreview();
  const all = state.discovery?.candidates || [];
  const filter = state.discoveryStatusFilter || "discovered";
  const sortBy = state.discoverySortBy || "subscribers";
  const num = (v) => Number(v) || 0;
  const DISCOVERY_SORTERS = {
    subscribers: (a, b) => num(b.subscribers) - num(a.subscribers),
    avgViews: (a, b) => num(b.avgViews) - num(a.avgViews),
    engagement: (a, b) => num(b.engagementRate) - num(a.engagementRate),
    recent: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  };
  const rows = (filter === "all" ? all : all.filter((c) => c.status === filter))
    .slice()
    .sort(DISCOVERY_SORTERS[sortBy] || DISCOVERY_SORTERS.subscribers);

  const count = $("#discoveryQueueCount");
  if (count) count.textContent = `${rows.length}명`;

  if (!rows.length) {
    // Empty: collapse the card into a single centered dashed box (no box-in-box).
    wrap.classList.add("is-empty");
    wrap.innerHTML = `<p class="discovery-empty">${filter === "discovered" ? "검수할 후보가 없습니다. 위에서 검색을 실행하세요." : "해당 상태의 후보가 없습니다."}</p>`;
    return;
  }
  wrap.classList.remove("is-empty");

  const body = rows.map((c) => discoveryRowHtml(c)).join("");

  wrap.innerHTML = `<table class="discovery-table">
    <thead><tr><th>채널</th><th>지표</th><th>이메일</th><th>AI 분석</th><th>액션</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function fmtCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

function discoveryRowHtml(c) {
  const channel = c.url
    ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.channelName || c.url)}</a>`
    : escapeHtml(c.channelName || "-");
  const known = c.isKnown ? ' <span class="tag-pill">기존</span>' : "";
  const lead = c.leadDepth ? ` <span class="tag-pill" title="그래프 탐색으로 발견">🔗d${c.leadDepth}</span>` : "";
  const plat = (c.gamePlatforms || [])
    .map((pf) => ` <span class="plat-chip plat-${escapeHtml(pf.toLowerCase())}">${escapeHtml(pf.replace(/_/g, " "))}</span>`)
    .join("");
  const email = c.email
    ? `<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`
    : '<span class="muted">없음</span>';

  // Dormant warning: no upload in ~90 days.
  let dormant = "";
  if (c.lastUploadAt) {
    const days = Math.floor((Date.now() - new Date(c.lastUploadAt).getTime()) / 86_400_000);
    if (days > 90) dormant = `<div class="muted small">⚠ ${days}일째 미업로드</div>`;
  }
  const metricBits = [
    c.subscribers ? `구독 <strong>${fmtCompact(c.subscribers)}</strong>` : "",
    c.avgViews ? `평균조회 <strong>${fmtCompact(c.avgViews)}</strong>` : "",
    c.engagementRate ? `참여율 <strong>${c.engagementRate}%</strong>` : "",
    c.uploadsPerMonth ? `${c.uploadsPerMonth}/월` : "",
  ].filter(Boolean);
  const metrics = metricBits.length ? metricBits.join(" · ") + dormant : '<span class="muted">-</span>';

  const tags = (c.tags || []).slice(0, 5).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join(" ");
  const analysis = [
    c.pitchAngle ? `<div class="discovery-pitch">💡 ${escapeHtml(c.pitchAngle)}</div>` : "",
    c.audience || c.contentTone
      ? `<div class="muted small">${escapeHtml([c.audience, c.contentTone, c.languages].filter(Boolean).join(" · "))}</div>`
      : "",
    tags ? `<div>${tags}</div>` : "",
  ]
    .filter(Boolean)
    .join("");

  let actions;
  if (c.status === "discovered") {
    actions = `<button type="button" class="mini-button" data-discovery-approve="${escapeHtml(c.id)}">승인</button>
      <button type="button" class="mini-button ghost" data-discovery-dismiss="${escapeHtml(c.id)}">제외</button>`;
  } else {
    actions = `<span class="status-pill small">${escapeHtml(discoveryStatusLabel(c.status))}</span>`;
  }

  return `<tr>
    <td class="discovery-channel">${channel}${known}${lead}${plat}<div class="muted small">${escapeHtml(c.channelType || c.platform || "")}</div></td>
    <td class="discovery-metrics">${metrics}</td>
    <td>${email}</td>
    <td class="discovery-reason">${analysis || '<span class="muted">-</span>'}</td>
    <td class="discovery-actions-cell">${actions}</td>
  </tr>`;
}

async function startDiscoveryRun({ durationMinutes = 0 } = {}) {
  const seeds = getDiscoverySeeds();
  const gamePlatforms = [...document.querySelectorAll('input[name="discoveryPlatform"]:checked')].map((el) => el.value);
  try {
    const result = await api("/api/discovery/run", { method: "POST", body: { seeds, durationMinutes, gamePlatforms } });
    if (result.started) {
      showToast(`${durationMinutes}분 세션을 시작했습니다.`);
      startDiscoveryPolling();
      await loadDiscovery();
    } else {
      const s = result.stats || {};
      showToast(`완료 — 채택 ${s.kept || 0} · 신규 ${s.newCreators || 0}`);
      state.discovery = { ...state.discovery, candidates: result.candidates, state: result.state };
      renderDiscovery();
    }
  } catch (error) {
    showToast(error.message);
  }
}

function initDiscovery() {
  const quick = $("#discoveryQuickRun");
  if (!quick) return; // view not present
  quick.addEventListener("click", async () => {
    quick.disabled = true;
    quick.textContent = "검색 중…";
    await startDiscoveryRun({ durationMinutes: 0 });
    quick.textContent = "빠른 실행 (1회)";
    renderDiscovery();
  });

  for (const btn of document.querySelectorAll("[data-discovery-minutes]")) {
    btn.addEventListener("click", () => startDiscoveryRun({ durationMinutes: Number(btn.dataset.discoveryMinutes) }));
  }

  // gemma-generated seed keywords → merged into the textarea (deduped).
  $("#discoverySeedAi")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const ta = $("#discoverySeeds");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "생성 중…";
    try {
      const existing = getDiscoverySeeds();
      const { seeds } = await api("/api/discovery/seeds", { method: "POST", body: { existingSeeds: existing, count: 10 } });
      const have = new Set(existing.map((s) => s.toLowerCase()));
      const added = (seeds || []).filter((s) => s && !have.has(s.toLowerCase()));
      if (added.length && ta) {
        ta.value = [...existing, ...added].join("\n");
        showToast(`AI 시드 ${added.length}개 추가했습니다.`);
      } else {
        showToast("새로 추가할 시드가 없습니다.");
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $("#discoveryStop")?.addEventListener("click", async () => {
    discoveryStopping = true;
    renderDiscovery();
    try {
      await api("/api/discovery/stop", { method: "POST", body: {} });
      showToast("세션을 중지합니다… 진행 중인 단계가 끝나면 멈춥니다.");
      // Keep polling so the button vanishes once `running` flips false.
      startDiscoveryPolling();
      await loadDiscovery();
    } catch (error) {
      showToast(error.message);
      discoveryStopping = false;
      renderDiscovery();
    }
  });

  $("#discoveryStatusFilter")?.addEventListener("change", (event) => {
    state.discoveryStatusFilter = event.target.value;
    renderDiscoveryQueue();
  });

  $("#discoverySortBy")?.addEventListener("change", (event) => {
    state.discoverySortBy = event.target.value;
    renderDiscoveryQueue();
  });

  $("#discoveryClearBtn")?.addEventListener("click", async () => {
    const filter = state.discoveryStatusFilter || "discovered";
    const label = { discovered: "검수 대기", approved: "승인됨", dismissed: "제외됨", all: "전체" }[filter] || filter;
    if (!window.confirm(`${label} 후보를 큐에서 비울까요? 되돌릴 수 없습니다.`)) return;
    try {
      const r = await api("/api/discovery/clear", { method: "POST", body: { status: filter } });
      discoverySeenIds = null; // reset bubble tracking after a bulk change
      showToast(`${r.removed}개 비웠습니다.`);
      await loadDiscovery();
    } catch (error) {
      showToast(error.message);
    }
  });

  // Conditional prune: live preview count + apply.
  for (const id of ["#pruneMinSubs", "#pruneDormant"]) {
    $(id)?.addEventListener("input", refreshPrunePreview);
  }
  $("#discoveryPruneBtn")?.addEventListener("click", async (event) => {
    const crit = discoveryPruneCriteria();
    if (!crit.minSubs && !crit.dormantMonths) return showToast("정리 조건을 하나 이상 입력하세요.");
    const n = (state.discovery?.candidates || []).filter((c) => discoveryPruneMatches(c, crit)).length;
    if (!n) return showToast("조건에 맞는 후보가 없습니다.");
    const parts = [
      crit.minSubs ? `구독자 ${number(crit.minSubs)} 이하` : "",
      crit.dormantMonths ? `${crit.dormantMonths}개월+ 미활동` : "",
    ].filter(Boolean).join(" · ");
    if (!window.confirm(`${parts}\n→ ${n}명을 큐에서 제거할까요? (재검색해도 다시 안 올라옴)`)) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("/api/discovery/prune", {
        method: "POST",
        body: { minSubscribers: crit.minSubs, dormantMonths: crit.dormantMonths },
      });
      discoverySeenIds = null;
      showToast(`${number(r.removed)}명 정리했습니다.`);
      await loadDiscovery();
    } catch (error) {
      showToast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#discoveryQueueWrap")?.addEventListener("click", async (event) => {
    const approveBtn = event.target.closest("[data-discovery-approve]");
    const dismissBtn = event.target.closest("[data-discovery-dismiss]");
    if (approveBtn) {
      approveBtn.disabled = true;
      try {
        await api(`/api/discovery/candidates/${encodeURIComponent(approveBtn.dataset.discoveryApprove)}/approve`, { method: "POST", body: {} });
        showToast("승인 — 크리에이터 DB에 추가했습니다.");
        await loadDiscovery();
      } catch (error) {
        showToast(error.message);
        approveBtn.disabled = false;
      }
    } else if (dismissBtn) {
      try {
        await api(`/api/discovery/candidates/${encodeURIComponent(dismissBtn.dataset.discoveryDismiss)}`, { method: "DELETE" });
        showToast("후보를 제외했습니다.");
        await loadDiscovery();
      } catch (error) {
        showToast(error.message);
      }
    }
  });
}

// "datasync" (Steam metrics & sync) removed from the nav: Overay Desk does not
// launch on Steam. The view markup/backend stay until the Steam code purge.
const VIEWS = ["overview", "campaigns", "creators", "discovery", "youtube", "reddit", "distribution", "admin"];

const VIEW_OF_SECTION = {
  today: "overview",
  readiness: "overview",
  campaigns: "campaigns",
  "creator-db": "creators",
  creators: "creators",
  outreach: "creators",
  discovery: "discovery",
  "discovery-queue": "discovery",
  youtube: "youtube",
  reddit: "reddit",
  keys: "distribution",
  utm: "distribution",
  games: "admin",
  settings: "admin",
  data: "admin",
};

const VIEW_META = {
  overview: { eyebrow: "Growth Overview", title: "그로스 대시보드" },
  campaigns: { eyebrow: "Campaign Performance", title: "캠페인 성과" },
  creators: { eyebrow: "Creator Relations", title: "크리에이터 & 섭외" },
  discovery: { eyebrow: "Discovery Bot", title: "크리에이터 찾아봇" },
  youtube: { eyebrow: "YouTube Analytics", title: "유튜브 채널 통계" },
  reddit: { eyebrow: "Reddit Log", title: "레딧 글 기록" },
  distribution: { eyebrow: "Distribution", title: "키 배포 & 링크" },
  admin: { eyebrow: "Workspace Admin", title: "제품 · 연동 · 설정" },
};

function showView(view, sectionId) {
  if (!VIEWS.includes(view)) view = "overview";
  for (const el of document.querySelectorAll(".view")) {
    el.classList.toggle("active", el.id === `view-${view}`);
  }
  for (const link of document.querySelectorAll(".nav-item")) {
    const on = link.dataset.view === view;
    link.classList.toggle("active", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const meta = VIEW_META[view];
  if (meta) {
    $("#viewEyebrow").textContent = meta.eyebrow;
    $("#viewTitle").textContent = meta.title;
  }
  // The creator matrix shows every game as a column and has its own "게임 N/N"
  // column filter, so the global game dropdown does nothing there — hide it.
  const gameFilterCtl = $("#gameFilterControl");
  if (gameFilterCtl) gameFilterCtl.style.display = view === "creators" ? "none" : "";
  if (view === "youtube" && state.youtube) renderYoutube();
  if (view === "discovery") loadDiscovery().catch(() => {});
  if (view === "overview" && state.dashboard) renderTrendChart(state.dashboard.trend);
  requestAnimationFrame(() => {
    const target = sectionId ? document.getElementById(sectionId) : null;
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function routeFromHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  if (VIEWS.includes(raw)) {
    showView(raw);
    return;
  }
  if (VIEW_OF_SECTION[raw]) {
    showView(VIEW_OF_SECTION[raw], raw);
    return;
  }
  showView("overview");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("overay-theme", theme);
  } catch (error) {
    /* ignore storage failures */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#090b12" : "#0e1626");
}

function setupShell() {
  try {
    const params = new URLSearchParams(location.search);
    const ytauth = params.get("ytauth");
    if (ytauth) {
      showToast(ytauth === "ok" ? "Google 계정을 연결했습니다." : `연결 실패: ${params.get("msg") || "오류"}`);
      params.delete("ytauth");
      params.delete("msg");
      const query = params.toString();
      history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    }
  } catch (error) {
    /* ignore */
  }
  initDiscovery();
  window.addEventListener("hashchange", routeFromHash);
  routeFromHash();
  let trendResizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(trendResizeTimer);
    trendResizeTimer = window.setTimeout(() => {
      if (state.dashboard) renderTrendChart(state.dashboard.trend);
      if (state.youtube) {
        renderYoutubeCharts(state.youtube.channels.find((c) => c.id === state.youtube.selectedChannelId));
      }
    }, 160);
  });
  const toggle = $("#themeToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }
}

// Bootstrap is triggered by the auth gate (auth.js) once a valid, allow-listed
// Microsoft account is signed in — or immediately when auth is disabled.
export function startDashboard() {
  initForms();
  setupShell();
  loadAll().catch((error) => {
    const status = $("#apiStatus");
    status.textContent = error.message;
    status.classList.add("fail");
    showToast(error.message);
  });
}
