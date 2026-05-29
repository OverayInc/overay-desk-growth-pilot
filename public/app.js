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
  if (Object.hasOwn(options, "body")) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
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
  for (const element of form.elements) {
    if (element.name && element.name !== "gameId") element.value = "";
  }
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
  $("#scopeBadge").textContent = dashboard.selectedGameId === "all" ? "전체 게임" : dashboard.selectedGameName || "전체 게임";
  $("#scopeMeta").textContent = `${number(dashboard.summary.campaigns)} campaigns / ${number(dashboard.summary.creators)} creators / ${number(dashboard.summary.keys)} keys`;
}

function renderMetricGrid(dashboard) {
  const items = [
    {
      label: "오늘 위시리스트",
      value: number(dashboard.today.wishlists),
      sub: `${number(dashboard.today.visits)} visits`,
      tone: "teal",
    },
    {
      label: "오늘 판매량",
      value: number(dashboard.today.purchases),
      sub: `${dashboard.today.purchaseRate}% purchase rate`,
      tone: "green",
    },
    {
      label: "오늘 매출",
      value: money(dashboard.today.revenue),
      sub: `${number(dashboard.today.refunds)} refunds`,
      tone: "amber",
    },
    {
      label: "최근 7일 위시",
      value: number(dashboard.last7.wishlists),
      sub: `${dashboard.last7.wishlistRate}% wishlist rate`,
      tone: "blue",
    },
    {
      label: "키 발송",
      value: number(dashboard.summary.keysSent),
      sub: `${number(dashboard.summary.keys)} records`,
      tone: "teal",
    },
    {
      label: "관리 게임",
      value: number(dashboard.summary.games),
      sub: `${number(dashboard.summary.campaigns)} campaigns`,
      tone: "green",
    },
  ];

  $("#metricGrid").innerHTML = items
    .map(
      (item) => `
        <article class="metric-card ${item.tone}">
          <span>${item.label}</span>
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
  $("#gameAdminSummary").textContent = `${number(activeGames.length)} active games / ${number(activeListings.length)} store listings`;

  if (!state.games.length) {
    $("#gameAdminTable").innerHTML = '<tr><td data-label="상태" colspan="7"><span class="empty">관리할 게임이 없습니다.</span></td></tr>';
  } else {
    $("#gameAdminTable").innerHTML = state.games
      .map((game) => {
        const listings = listingsForGame(game.id);
        return `
          <tr>
            <td data-label="게임">
              <span class="cell-title">${escapeHtml(game.name)}</span>
              <span class="cell-sub">${escapeHtml(game.genre || "No genre")}</span>
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
                    ? ""
                    : `<button class="table-button secondary-button danger-button" type="button" data-archive-game-id="${escapeHtml(game.id)}">Archive</button>`
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  if (!state.storeListings.length) {
    $("#storeListingTable").innerHTML = '<tr><td data-label="상태" colspan="6"><span class="empty">연결된 스토어 리스팅이 없습니다.</span></td></tr>';
    return;
  }

  $("#storeListingTable").innerHTML = state.storeListings
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
        </tr>
      `,
    )
    .join("");
}

function renderPortfolio() {
  const portfolio = (state.dashboard.portfolio || state.games).filter((game) => !game.archived);
  const maxWishlist = Math.max(...portfolio.map((game) => Number(game.wishlists || 0)), 1);
  $("#portfolioSummary").textContent = `${number(portfolio.length)} active games`;
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
  $("#readinessSummary").textContent = `${number(readiness.summary.readyGames)} ready / ${number(readiness.summary.games)} games`;
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
            <div>
              <h3>${escapeHtml(game.gameName)}</h3>
              <span class="cell-sub">${escapeHtml((game.platforms || []).map((platform) => platform.label).join(", ") || "No store")} / ${escapeHtml(game.status)}</span>
            </div>
            <div class="readiness-score">${number(game.score)}%</div>
          </header>
          <div class="check-grid">
            ${game.checks
              .map((check) => `<span class="check-chip ${check.ok ? "ok" : ""}">${check.ok ? "OK" : "Need"} ${escapeHtml(check.label)}</span>`)
              .join("")}
          </div>
          <div class="cell-sub">
            ${number(game.counts.campaigns)} campaigns / ${number(game.counts.creators)} creators / ${number(game.counts.metrics)} metric rows
          </div>
        </article>
      `,
    )
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
          <div class="bar-meta">${number(campaign.wishlists)} wish / ${number(campaign.purchases)} buy</div>
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
  $("#campaignCount").textContent = `${number(state.campaigns.length)} campaigns`;
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
  $("#creatorProfileCount").textContent = `${number(state.creatorProfiles.length)} profiles`;
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
          <td data-label="사용 게임">${escapeHtml(games)}<span class="cell-sub">${number(profile.stats?.outreachCount)} outreach</span></td>
          <td data-label="상태"><span class="status ${escapeHtml(profile.status)}">${escapeHtml(profile.status)}</span></td>
          <td data-label="메일"><button class="secondary-button table-button" type="button" data-email-profile-id="${escapeHtml(profile.id)}" ${canDraft}>초안</button></td>
        </tr>
      `;
    })
    .join("");
}

function renderCreators() {
  $("#creatorCount").textContent = `${number(state.creators.length)} creators`;
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
  $("#keyCount").textContent = `${number(state.keys.length)} keys`;
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
  $("#metricCount").textContent = `${number(state.metrics.length)} rows`;
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
    ["API Key", status.keyEnv],
    ["App ID Games", `${number(status.gamesWithAppIds)} / ${number(status.totalGames)}`],
    ["Sales Watermark", status.salesHighwatermark || "0"],
    ["Last Status", status.lastStatus || "never_run"],
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
  $("#emailStatusLabel").textContent = status.configured ? "SMTP configured" : "SMTP missing";
  $("#emailStatusGrid").innerHTML = [
    ["Mode", status.mode],
    ["SMTP Host", status.host],
    ["From", status.from],
    ["Auth", status.auth],
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
  $("#outreachLogCount").textContent = `${number(state.outreachLogs.length)} logs`;
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
    if (editButton) {
      const select = $("#settingsGameSelect");
      select.value = editButton.dataset.editGameId;
      populateGameSettingsForm(select.value);
      $("#gameSettingsForm").closest("details")?.setAttribute("open", "");
      location.hash = "#games";
      return;
    }
    if (!archiveButton) return;
    archiveButton.disabled = true;
    try {
      await api(`/api/games/${encodeURIComponent(archiveButton.dataset.archiveGameId)}`, {
        method: "DELETE",
      });
      await loadAll();
      showToast("게임을 archive 처리했습니다.");
    } catch (error) {
      showToast(error.message);
    } finally {
      archiveButton.disabled = false;
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

  $("#refreshButton").addEventListener("click", async () => {
    try {
      await loadAll();
      showToast("새로고침했습니다.");
    } catch (error) {
      showToast(error.message);
    }
  });
}

initForms();
loadAll().catch((error) => {
  const status = $("#apiStatus");
  status.textContent = error.message;
  status.classList.add("fail");
  showToast(error.message);
});
