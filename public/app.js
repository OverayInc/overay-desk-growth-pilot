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
};

const numberFormat = new Intl.NumberFormat("ko-KR");
const currencyFormat = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const $ = (selector) => document.querySelector(selector);

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
    steam: "Steam",
    meta_horizon: "Meta Horizon Store",
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

function renderGameSelectors() {
  const filter = $("#gameFilter");
  const current = state.selectedGameId;
  filter.innerHTML = [
    '<option value="all">전체 게임</option>',
    ...state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`),
  ].join("");
  filter.value = current === "all" || state.games.some((game) => game.id === current) ? current : "all";

  for (const select of document.querySelectorAll("[data-game-select]")) {
    const previous = state.selectedGameId === "all" ? select.value || selectedGameForForms() : selectedGameForForms();
    select.disabled = !state.games.length;
    select.innerHTML = state.games.length
      ? state.games.map((game) => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}</option>`).join("")
      : '<option value="">게임을 먼저 추가</option>';
    select.value = state.games.some((game) => game.id === previous) ? previous : selectedGameForForms();
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
  for (const formId of ["#campaignForm", "#creatorForm", "#keyForm", "#csvForm", "#utmForm", "#gameSettingsForm", "#storeListingForm"]) {
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
  const items = [
    {
      label: "오늘 위시리스트",
      value: number(dashboard.today.wishlists),
      sub: `방문 ${number(dashboard.today.visits)}`,
      tone: "teal",
      icon: ICONS.wishlist,
    },
    {
      label: "오늘 판매",
      value: number(dashboard.today.purchases),
      sub: `구매 전환율 ${dashboard.today.purchaseRate}%`,
      tone: "green",
      icon: ICONS.purchases,
    },
    {
      label: "오늘 매출",
      value: money(dashboard.today.revenue),
      sub: `환불 ${number(dashboard.today.refunds)}건`,
      tone: "amber",
      icon: ICONS.revenue,
    },
    {
      label: "최근 7일 위시리스트",
      value: number(dashboard.last7.wishlists),
      sub: `위시 전환율 ${dashboard.last7.wishlistRate}%`,
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
      label: "운영 게임",
      value: number(dashboard.summary.games),
      sub: `캠페인 ${number(dashboard.summary.campaigns)}개`,
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

function renderGameAdmin() {
  const activeGames = state.games.filter((game) => !game.archived);
  const activeListings = state.storeListings.filter((listing) => listing.status !== "archived");
  $("#gameAdminSummary").textContent = `운영 게임 ${number(activeGames.length)}개 · 스토어 리스팅 ${number(activeListings.length)}개`;

  if (!state.games.length) {
    $("#gameAdminTable").innerHTML = '<tr><td data-label="상태" colspan="7"><span class="empty">관리할 게임이 없습니다.</span></td></tr>';
  } else {
    $("#gameAdminTable").innerHTML = state.games
      .map((game) => {
        const listings = listingsForGame(game.id);
        return `
          <tr>
            <td data-label="게임">
              <div class="cell-with-thumb">
                ${gameThumb(game, "game-thumb--sm")}
                <div>
                  <span class="cell-title">${escapeHtml(game.name)}</span>
                  <span class="cell-sub">${escapeHtml(game.genre || "No genre")}</span>
                </div>
              </div>
            </td>
            <td data-label="단계"><span class="status ${escapeHtml(game.stage || "concept")}">${escapeHtml(game.stage || "concept")}</span></td>
            <td data-label="스토어">${renderPlatformChips(listings)}</td>
            <td data-label="담당">${escapeHtml(game.owner || "Growth")}</td>
            <td data-label="출시일">${escapeHtml(game.launchDate || "-")}</td>
            <td data-label="상태"><span class="status ${game.archived ? "archived" : "active"}">${game.archived ? "archived" : "active"}</span></td>
            <td data-label="작업">
              <div class="action-row">
                <button class="table-button secondary-button" type="button" data-edit-game-id="${escapeHtml(game.id)}">수정</button>
                ${
                  game.archived
                    ? `<button class="table-button secondary-button" type="button" data-restore-game-id="${escapeHtml(game.id)}">복구</button>`
                    : `<button class="table-button secondary-button" type="button" data-archive-game-id="${escapeHtml(game.id)}">보관</button>`
                }
                <button class="table-button secondary-button danger-button" type="button" data-purge-game-id="${escapeHtml(game.id)}" data-game-name="${escapeHtml(game.name)}">삭제</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  const visibleListings = state.storeListings.filter((listing) => listing.status !== "archived");
  if (!visibleListings.length) {
    $("#storeListingTable").innerHTML = '<tr><td data-label="상태" colspan="7"><span class="empty">연결된 스토어 리스팅이 없습니다.</span></td></tr>';
    return;
  }

  $("#storeListingTable").innerHTML = visibleListings
    .map(
      (listing) => `
        <tr>
          <td data-label="게임"><span class="cell-title">${escapeHtml(listing.gameName || gameName(listing.gameId))}</span></td>
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

function renderPortfolio() {
  const portfolio = (state.dashboard.portfolio || state.games).filter((game) => !game.archived);
  const maxWishlist = Math.max(...portfolio.map((game) => Number(game.wishlists || 0)), 1);
  $("#portfolioSummary").textContent = `운영 게임 ${number(portfolio.length)}개`;
  if (!portfolio.length) {
    $("#portfolioGrid").innerHTML = `
      <div class="empty-state">
        <strong>아직 등록된 게임이 없습니다.</strong>
        <span>첫 게임을 추가하면 캠페인, 크리에이터, CSV, Steam 동기화를 게임별로 묶어 볼 수 있습니다.</span>
      </div>
    `;
    return;
  }
  $("#portfolioGrid").innerHTML = portfolio
    .map(
      (game) => {
        const active = state.selectedGameId === game.id ? " active" : "";
        const width = Math.max(4, Math.round((Number(game.wishlists || 0) / maxWishlist) * 100));
        const listings = game.storeListings || listingsForGame(game.id);
        return `
        <button class="game-card${active}" type="button" data-game-id="${escapeHtml(game.id)}" aria-pressed="${state.selectedGameId === game.id ? "true" : "false"}">
          <header>
            ${gameThumb(game, "game-thumb--md")}
            <div>
              <h3>${escapeHtml(game.name)}</h3>
              <span class="cell-sub">${escapeHtml(game.genre || "No genre")}</span>
              ${renderPlatformChips(listings.filter((listing) => listing.status !== "archived"))}
            </div>
            <span class="stage ${escapeHtml(game.stage)}">${escapeHtml(game.stage)}</span>
          </header>
          <dl>
            <div><dt>Wishlists</dt><dd>${number(game.wishlists)}</dd></div>
            <div><dt>Purchases</dt><dd>${number(game.purchases)}</dd></div>
            <div><dt>Revenue</dt><dd>${money(game.revenue)}</dd></div>
            <div><dt>Creators</dt><dd>${number(game.creators)}</dd></div>
            <div class="mini-bar"><span style="width:${width}%"></span></div>
          </dl>
        </button>
      `;
      },
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

function renderYoutube() {
  const yt = state.youtube;
  if (!yt) return;
  const statusEl = $("#youtubeStatus");
  if (statusEl) {
    statusEl.textContent = yt.configured ? `API 연결됨 · 채널 ${number(yt.channels.length)}개` : "API 키 미설정";
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

function renderRedditPosts() {
  if (!$("#redditTable")) return;
  $("#redditCount").textContent = `글 ${number(state.redditPosts.length)}개`;
  if (!state.redditPosts.length) {
    $("#redditTable").innerHTML = '<tr><td data-label="상태" colspan="7"><span class="empty">기록된 레딧 글이 없습니다.</span></td></tr>';
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
  renderPortfolio();
  renderMetricGrid(dashboard);
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

function renderCreatorProfiles() {
  $("#creatorProfileCount").textContent = `프로필 ${number(state.creatorProfiles.length)}개`;
  if (!state.creatorProfiles.length) {
    $("#creatorProfileTable").innerHTML = '<tr><td data-label="상태" colspan="8"><span class="empty">공용 크리에이터 DB가 비어 있습니다.</span></td></tr>';
    return;
  }
  $("#creatorProfileTable").innerHTML = state.creatorProfiles
    .map((profile) => {
      const games = profile.stats?.gameNames?.length ? profile.stats.gameNames.join(", ") : "-";
      const canDraft = state.games.length ? "" : "disabled";
      return `
        <tr>
          <td data-label="채널"><span class="cell-title">${escapeHtml(profile.channelName)}</span><span class="cell-sub">${escapeHtml(profile.platform)} @${escapeHtml(profile.handle)}</span></td>
          <td data-label="연락처">${escapeHtml(profile.email || "-")}<span class="cell-sub">${escapeHtml(profile.country || "-")}</span></td>
          <td data-label="태그"><div class="tag-row">${(profile.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div></td>
          <td data-label="조회수" class="num">${number(profile.averageViews)}</td>
          <td data-label="적합도" class="num">${number(profile.fitScore)}</td>
          <td data-label="사용 게임">${escapeHtml(games)}<span class="cell-sub">아웃리치 ${number(profile.stats?.outreachCount)}회</span></td>
          <td data-label="상태"><span class="status ${escapeHtml(profile.status)}">${escapeHtml(profile.status)}</span></td>
          <td data-label="메일"><button class="secondary-button table-button" type="button" data-email-profile-id="${escapeHtml(profile.id)}" ${canDraft}>초안</button></td>
        </tr>
      `;
    })
    .join("");
}

function renderCreators() {
  $("#creatorCount").textContent = `크리에이터 ${number(state.creators.length)}명`;
  if (!state.creators.length) {
    $("#creatorTable").innerHTML = '<tr><td data-label="상태" colspan="9"><span class="empty">크리에이터가 없습니다.</span></td></tr>';
    return;
  }
  $("#creatorTable").innerHTML = state.creators
    .map(
      (creator) => `
        <tr>
          <td data-label="채널"><span class="cell-title">${escapeHtml(creator.channelName)}</span><span class="cell-sub">${escapeHtml(creator.platform)} ${escapeHtml(creator.email)}</span></td>
          <td data-label="게임">${escapeHtml(creator.gameName || gameName(creator.gameId))}</td>
          <td data-label="태그"><div class="tag-row">${(creator.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div></td>
          <td data-label="국가">${escapeHtml(creator.country)}</td>
          <td data-label="조회수" class="num">${number(creator.averageViews)}</td>
          <td data-label="적합도" class="num">${number(creator.fitScore)}</td>
          <td data-label="상태"><span class="status ${escapeHtml(creator.status)}">${escapeHtml(creator.status)}</span></td>
          <td data-label="UTM" class="link-cell">${creator.utmLink ? `<a href="${escapeHtml(creator.utmLink)}" target="_blank" rel="noreferrer">열기</a>` : "-"}</td>
          <td data-label="메일"><button class="secondary-button table-button" type="button" data-email-creator-id="${escapeHtml(creator.id)}">초안</button></td>
        </tr>
      `,
    )
    .join("");
}

function renderKeys() {
  $("#keyCount").textContent = `키 ${number(state.keys.length)}개`;
  if (!state.keys.length) {
    $("#keyTable").innerHTML = '<tr><td data-label="상태" colspan="6"><span class="empty">키 배포 기록이 없습니다.</span></td></tr>';
    return;
  }
  $("#keyTable").innerHTML = state.keys
    .map(
      (key) => `
        <tr>
          <td data-label="수신자"><span class="cell-title">${escapeHtml(key.recipientName)}</span><span class="cell-sub">${escapeHtml(key.recipientEmail)}</span></td>
          <td data-label="게임">${escapeHtml(key.gameName || gameName(key.gameId))}</td>
          <td data-label="상태"><span class="status ${escapeHtml(key.status)}">${escapeHtml(key.status)}</span></td>
          <td data-label="키">${escapeHtml(key.steamKeyMasked || "-")}</td>
          <td data-label="캠페인">${escapeHtml(key.campaignName || key.campaignId || "-")}</td>
          <td data-label="메모">${escapeHtml(key.note || "-")}</td>
        </tr>
      `,
    )
    .join("");
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
  $("#emailStatusLabel").textContent = status.configured ? "SMTP 설정됨" : "SMTP 미설정";
  $("#emailStatusGrid").innerHTML = [
    ["발송 모드", status.mode],
    ["SMTP 호스트", status.host],
    ["발신 주소", status.from],
    ["인증", status.auth],
  ]
    .map(([label, value]) => `<div class="sync-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
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

  const emailStatus = $("#emailSettingsStatus");
  emailStatus.textContent = email.configured ? email.mode : "missing";
  emailStatus.className = `status-pill ${email.configured ? "ok" : "fail"}`;
  $("#emailSettingsMeta").textContent = email.configured
    ? `${email.host}:${email.port} · ${email.from} · auth ${email.auth}`
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
}

function renderOutreachLogs() {
  $("#outreachLogCount").textContent = `로그 ${number(state.outreachLogs.length)}개`;
  if (!state.outreachLogs.length) {
    $("#outreachLogTable").innerHTML = '<tr><td data-label="상태" colspan="4"><span class="empty">발송 로그가 없습니다.</span></td></tr>';
    return;
  }
  $("#outreachLogTable").innerHTML = state.outreachLogs
    .slice(0, 30)
    .map(
      (log) => `
        <tr>
          <td data-label="시간">${escapeHtml(log.createdAt)}</td>
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

function renderEmailDraft(draft) {
  state.currentEmailDraft = draft;
  $("#emailDraftResult").innerHTML = `
    <div class="email-draft">
      <header>
        <div>
          <strong>${escapeHtml(draft.subject)}</strong>
          <span>${escapeHtml(draft.to || "수신 이메일 없음")}</span>
        </div>
        <div class="button-row">
          <a href="${escapeHtml(draft.mailto)}">메일 앱 열기</a>
          <button type="button" id="sendDraftButton">실제 발송</button>
        </div>
      </header>
      <textarea readonly>${escapeHtml(draft.body)}</textarea>
      <div class="link-cell"><a href="${escapeHtml(draft.utmLink)}" target="_blank" rel="noreferrer">${escapeHtml(draft.utmLink)}</a></div>
    </div>
  `;
}

function renderCreatorCsvPreview(preview) {
  $("#creatorCsvPreviewResult").innerHTML = `
    <div class="preview-grid">
      <div class="preview-stats">
        <span>${number(preview.totalRows)} rows</span>
        <span>${number(preview.newRows)} new</span>
        <span>${number(preview.updateRows)} update</span>
        <span>${number(preview.duplicateRows)} duplicate</span>
      </div>
      ${
        preview.warnings?.length
          ? `<div class="empty">${preview.warnings.map((warning) => escapeHtml(warning)).join("<br>")}</div>`
          : ""
      }
      <div class="table-wrap compact">
        <table>
          <thead><tr><th>채널</th><th>플랫폼</th><th>이메일</th><th>태그</th><th>조회수</th><th>적합도</th></tr></thead>
          <tbody>
            ${
              preview.previewRows?.length
                ? preview.previewRows
                    .map(
                      (row) => `
                        <tr>
                          <td data-label="채널">${escapeHtml(row.channelName)}</td>
                          <td data-label="플랫폼">${escapeHtml(row.platform)}</td>
                          <td data-label="이메일">${escapeHtml(row.email || "-")}</td>
                          <td data-label="태그">${escapeHtml((row.tags || []).join(", "))}</td>
                          <td data-label="조회수" class="num">${number(row.averageViews)}</td>
                          <td data-label="적합도" class="num">${number(row.fitScore)}</td>
                        </tr>
                      `,
                    )
                    .join("")
                : '<tr><td data-label="상태" colspan="6"><span class="empty">미리볼 행이 없습니다.</span></td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
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

async function createEmailDraft(payload) {
  const gameId = selectedGameForForms();
  if (!gameId) {
    showToast("메일 초안을 만들 게임을 먼저 추가하세요.");
    return;
  }
  const draft = await api("/api/email-drafts", {
    method: "POST",
    body: {
      ...payload,
      gameId,
    },
  });
  renderEmailDraft(draft);
  showToast("메일 초안을 만들었습니다.");
}

function renderAll() {
  renderGameSelectors();
  renderGameAdmin();
  renderDashboard();
  renderReadiness();
  renderCampaigns();
  renderCreatorProfiles();
  renderCreators();
  renderKeys();
  renderMetrics();
  renderSyncStatus();
  renderSyncSchedule();
  renderEmailStatus();
  renderSettings();
  renderOutreachLogs();
  renderYoutube();
  renderRedditPosts();
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
    keys,
    metrics,
    syncStatus,
    syncSchedule,
    settings,
    emailStatus,
    outreachLogs,
    youtube,
    redditPosts,
  ] = await Promise.all([
    api("/api/health"),
    api("/api/games"),
    api("/api/store-listings?includeArchived=true"),
    api(`/api/dashboard?${query}`),
    api("/api/readiness"),
    api(`/api/campaigns?${query}`),
    api("/api/creator-profiles"),
    api(`/api/creators?${query}`),
    api(`/api/keys?${query}`),
    api(`/api/steam-metrics?${query}`),
    api("/api/steam-sync/status"),
    api("/api/sync-schedule"),
    api("/api/settings"),
    api("/api/email/status"),
    api(`/api/outreach-logs?${query}`),
    api("/api/youtube"),
    api(`/api/reddit-posts?${query}`),
  ]);
  state.games = games;
  state.storeListings = storeListings;
  state.dashboard = dashboard;
  state.readiness = readiness;
  state.campaigns = campaigns;
  state.creatorProfiles = creatorProfiles;
  state.creators = creators;
  state.keys = keys;
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

  bindForm("#creatorProfileForm", (data) =>
    api("/api/creator-profiles", {
      method: "POST",
      body: data,
    }),
  );

  bindForm(
    "#creatorCsvForm",
    async (data, form) => {
      const result = await api("/api/import/creator-csv", {
        method: "POST",
        body: { csvText: data.csvText },
      });
      showToast(`${result.imported}개 추가, ${result.updated}개 갱신`);
      form.querySelector("textarea").value = data.csvText;
    },
    { keepValues: true },
  );

  bindForm("#creatorForm", (data) =>
    api("/api/creators", {
      method: "POST",
      body: withSelectedGame(data),
    }),
  );

  bindForm("#keyForm", (data) =>
    api("/api/keys", {
      method: "POST",
      body: withSelectedGame(data),
    }),
  );

  bindForm("#redditPostForm", (data) =>
    api("/api/reddit-posts", {
      method: "POST",
      body: data,
    }),
  );

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
        },
      }),
    { keepValues: true },
  );

  $("#creatorCsvPreviewButton").addEventListener("click", async () => {
    try {
      const data = formData($("#creatorCsvForm"));
      const preview = await api("/api/import/creator-csv/preview", {
        method: "POST",
        body: { csvText: data.csvText },
      });
      renderCreatorCsvPreview(preview);
      showToast("Creator CSV 미리보기를 만들었습니다.");
    } catch (error) {
      showToast(error.message);
    }
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

  $("#gameAdminTable").addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-edit-game-id]");
    const archiveButton = event.target.closest("[data-archive-game-id]");
    const restoreButton = event.target.closest("[data-restore-game-id]");
    const purgeButton = event.target.closest("[data-purge-game-id]");
    if (editButton) {
      const select = $("#settingsGameSelect");
      select.value = editButton.dataset.editGameId;
      populateGameSettingsForm(select.value);
      $("#gameSettingsForm").closest("details")?.setAttribute("open", "");
      location.hash = "#games";
      return;
    }
    if (restoreButton) {
      restoreButton.disabled = true;
      try {
        await api(`/api/games/${encodeURIComponent(restoreButton.dataset.restoreGameId)}`, {
          method: "PUT",
          body: { archived: false },
        });
        await loadAll();
        renderGameSelectors();
        showToast("게임을 복구했습니다.");
      } catch (error) {
        showToast(error.message);
      } finally {
        restoreButton.disabled = false;
      }
      return;
    }
    if (purgeButton) {
      const name = purgeButton.dataset.gameName || "이 게임";
      if (!window.confirm(`'${name}' 게임과 연결된 모든 캠페인·크리에이터·키·지표·스토어 리스팅이 영구 삭제됩니다. 되돌릴 수 없습니다. 삭제할까요?`)) {
        return;
      }
      purgeButton.disabled = true;
      try {
        await api(`/api/games/${encodeURIComponent(purgeButton.dataset.purgeGameId)}?purge=true`, {
          method: "DELETE",
        });
        if (state.selectedGameId === purgeButton.dataset.purgeGameId) {
          state.selectedGameId = "all";
        }
        await loadAll();
        renderGameSelectors();
        showToast("게임을 영구 삭제했습니다.");
      } catch (error) {
        showToast(error.message);
      } finally {
        purgeButton.disabled = false;
      }
      return;
    }
    if (!archiveButton) return;
    archiveButton.disabled = true;
    try {
      await api(`/api/games/${encodeURIComponent(archiveButton.dataset.archiveGameId)}`, {
        method: "DELETE",
      });
      await loadAll();
      showToast("게임을 보관 처리했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      archiveButton.disabled = false;
    }
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
    event.currentTarget.disabled = true;
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
      event.currentTarget.disabled = false;
    }
  });

  $("#creatorProfileTable").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-email-profile-id]");
    if (!button) return;
    button.disabled = true;
    try {
      await createEmailDraft({ creatorProfileId: button.dataset.emailProfileId });
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#creatorTable").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-email-creator-id]");
    if (!button) return;
    button.disabled = true;
    try {
      await createEmailDraft({ creatorId: button.dataset.emailCreatorId });
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#emailDraftResult").addEventListener("click", async (event) => {
    const button = event.target.closest("#sendDraftButton");
    if (!button || !state.currentEmailDraft) return;
    button.disabled = true;
    try {
      const result = await api("/api/email-send", {
        method: "POST",
        body: { draft: state.currentEmailDraft },
      });
      await loadAll();
      showToast(result.message || result.status);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
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
      downloadJson(`launch-pilot-${type}-${stamp}.json`, data);
      $("#exportResult").textContent = `${type} export 생성 완료`;
      showToast("내보내기를 만들었습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#portfolioGrid").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-game-id]");
    if (!card) return;
    await setGameScope(card.dataset.gameId);
  });

  $("#youtubeConfigPanel")?.addEventListener("toggle", (event) => {
    event.currentTarget.dataset.touched = "1";
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
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/youtube/sync", { method: "POST", body: {} });
      await loadAll();
      showToast(result.warnings?.length ? result.warnings[0] : `동기화 완료 · 채널 ${result.synced}개`);
    } catch (error) {
      showToast(error.message);
    } finally {
      event.currentTarget.disabled = false;
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

  $("#redditRefreshButton")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/reddit-posts/refresh", { method: "POST", body: {} });
      await loadAll();
      showToast(result.warning ? result.warning : `반응 갱신 완료 · ${result.updated}/${result.total}건`);
    } catch (error) {
      showToast(error.message);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

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

const VIEWS = ["overview", "campaigns", "creators", "youtube", "reddit", "distribution", "datasync", "admin"];

const VIEW_OF_SECTION = {
  today: "overview",
  portfolio: "overview",
  readiness: "overview",
  campaigns: "campaigns",
  "creator-db": "creators",
  creators: "creators",
  outreach: "creators",
  youtube: "youtube",
  reddit: "reddit",
  keys: "distribution",
  utm: "distribution",
  steam: "datasync",
  sync: "datasync",
  games: "admin",
  settings: "admin",
  data: "admin",
};

const VIEW_META = {
  overview: { eyebrow: "Growth Overview", title: "그로스 대시보드" },
  campaigns: { eyebrow: "Campaign Performance", title: "캠페인 성과" },
  creators: { eyebrow: "Creator Relations", title: "크리에이터 & 섭외" },
  youtube: { eyebrow: "YouTube Analytics", title: "유튜브 채널 통계" },
  reddit: { eyebrow: "Reddit Log", title: "레딧 글 기록" },
  distribution: { eyebrow: "Distribution", title: "키 배포 & 링크" },
  datasync: { eyebrow: "Data Pipeline", title: "Steam 데이터 & 동기화" },
  admin: { eyebrow: "Workspace Admin", title: "게임 · 연동 · 설정" },
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
  if (view === "youtube" && state.youtube) renderYoutube();
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
  window.addEventListener("hashchange", routeFromHash);
  routeFromHash();
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
