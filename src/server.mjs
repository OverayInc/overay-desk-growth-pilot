import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, loadData, persistData, migrateFromJson } from "./db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT_DIR, "data", "app-data.json");
const DATA_DB = process.env.DATA_DB || path.join(ROOT_DIR, "data", "app.db");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const STEAM_APP_ID = String(process.env.STEAM_APP_ID || "0");
const KEY_SECRET = process.env.KEY_ENCRYPTION_SECRET || "development-only-change-me";
const DEFAULT_GAME_ID = "";
const STEAM_FINANCIAL_API_KEY = process.env.STEAM_FINANCIAL_API_KEY || process.env.STEAM_PUBLISHER_WEB_API_KEY || "";
const STEAM_API_BASE = "https://partner.steam-api.com/IPartnerFinancialsService";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const REDDIT_USER_AGENT =
  process.env.REDDIT_USER_AGENT || "web:launch-pilot-growth-console:1.0 (internal marketing dashboard)";
const REDDIT_OAUTH_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_OAUTH_API_BASE = "https://oauth.reddit.com";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2/reports";
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_OAUTH_SCOPE =
  "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587));
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_STARTTLS = process.env.SMTP_STARTTLS !== "false";
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER || "";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "";
const EMAIL_SEND_MODE = process.env.EMAIL_SEND_MODE || "smtp";
const DISABLE_SYNC_SCHEDULER = process.env.DISABLE_SYNC_SCHEDULER === "true";
const SYNC_SCHEDULER_INTERVAL_MS = Number(process.env.SYNC_SCHEDULER_INTERVAL_MS || 60_000);
const DEFAULT_SYNC_LOOKBACK_DAYS = Number(process.env.DEFAULT_SYNC_LOOKBACK_DAYS || 7);

const STATUS_OPTIONS = new Set([
  "uncontacted",
  "drafted",
  "first_sent",
  "replied",
  "key_sent",
  "video_uploaded",
  "paused",
]);

const KEY_STATUS_OPTIONS = new Set(["reserved", "sent", "claimed", "video_uploaded", "revoked"]);

const STORE_PLATFORM_LABELS = {
  steam: "Steam",
  meta_horizon: "Meta Horizon Store",
  itch: "itch.io",
  epic: "Epic Games Store",
  playstation: "PlayStation Store",
  quest: "Meta Quest",
  other: "Other Store",
};

const STORE_STATUS_OPTIONS = new Set(["planned", "draft", "submitted", "live", "paused", "archived"]);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix, value = "") {
  const base = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  const suffix = randomBytes(3).toString("hex");
  return [prefix, base || suffix, suffix].join("_");
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const normalized = String(value).replace(/[$,%\s]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) return [];
  return String(value)
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value, fallback = "item") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || fallback
  );
}

function normalizeStorePlatform(value = "steam") {
  const raw = String(value || "steam")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "meta" || raw === "meta_store" || raw === "horizon" || raw === "horizon_store" || raw === "quest_store") {
    return "meta_horizon";
  }
  if (raw === "epic_games") return "epic";
  if (raw === "itchio" || raw === "itch_io") return "itch";
  return Object.hasOwn(STORE_PLATFORM_LABELS, raw) ? raw : "other";
}

function storePlatformLabel(platform) {
  return STORE_PLATFORM_LABELS[normalizeStorePlatform(platform)] || STORE_PLATFORM_LABELS.other;
}

function normalizeListingStatus(value = "draft") {
  const status = String(value || "draft").trim().toLowerCase();
  return STORE_STATUS_OPTIONS.has(status) ? status : "draft";
}

function steamStoreUrl(appId, name) {
  const safeAppId = String(appId || "0");
  const slug = String(name || "Game").trim().replace(/\s+/g, "_");
  return `https://store.steampowered.com/app/${safeAppId}/${encodeURIComponent(slug)}`;
}

// Game profile image: stored inline as a small square data URL. Validate the
// shape and cap the size so the data file cannot be bloated with huge payloads.
function sanitizeGameImage(value) {
  const str = String(value || "").trim();
  if (!str) return "";
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(str)) return "";
  if (str.length > 1_500_000) return "";
  return str;
}

function defaultGames() {
  return [];
}

function defaultData() {
  const games = defaultGames();
  return {
    meta: {
      portfolioName: "Launch Pilot Growth Dashboard",
      primaryGameId: "",
      createdAt: nowIso(),
    },
    games,
    storeListings: [],
    campaigns: [],
    creatorProfiles: [],
    creators: [],
    influencerKeys: [],
    steamDailyMetrics: [],
    outreachLogs: [],
    steamSyncState: {
      salesHighwatermark: "0",
      lastRunAt: "",
      lastStatus: "never_run",
      lastMessage: "",
    },
    integrationSettings: {
      steamFinancialApiKeyEncrypted: "",
      steamFinancialApiKeyMasked: "",
      youtubeApiKeyEncrypted: "",
      youtubeApiKeyMasked: "",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      smtpPassEncrypted: "",
      smtpPassMasked: "",
      smtpSecure: false,
      smtpStarttls: true,
      emailFrom: "",
      emailReplyTo: "",
      emailSendMode: "smtp",
      youtubeClientId: "",
      youtubeClientSecretEncrypted: "",
      youtubeClientSecretMasked: "",
      youtubeRefreshTokenEncrypted: "",
      youtubeAccessToken: "",
      youtubeAccessTokenExpiry: 0,
      youtubeOAuthConnectedAt: "",
      youtubeOAuthState: "",
      redditClientId: "",
      redditClientSecretEncrypted: "",
      redditClientSecretMasked: "",
      redditAccessToken: "",
      redditAccessTokenExpiry: 0,
      updatedAt: "",
    },
    syncSchedule: {
      enabled: false,
      intervalHours: 24,
      gameId: "all",
      includeWishlist: true,
      includeSales: false,
      includeViewGrants: false,
      lookbackDays: 7,
      startOffsetDays: 1,
      lastRunAt: "",
      nextRunAt: "",
      lastRunId: "",
      lastStatus: "never_run",
      lastMessage: "",
    },
    syncRuns: [],
    youtubeChannels: [],
    youtubeSnapshots: [],
    redditPosts: [],
  };
}

let dbReady = false;
function ensureDb() {
  if (dbReady) return;
  initDb(DATA_DB);
  // First run: import the legacy app-data.json if present, otherwise seed defaults.
  migrateFromJson(DATA_FILE, defaultData);
  dbReady = true;
}

async function readData() {
  ensureDb();
  const data = loadData();
  normalizeData(data);
  return data;
}

function normalizeData(data) {
  const seeded = defaultData();
  data.meta ||= seeded.meta;
  data.meta.portfolioName ||= "Launch Pilot Growth Dashboard";
  data.games ||= [];
  data.storeListings ||= [];
  if (data.meta.primaryGameId && !data.games.some((game) => game.id === data.meta.primaryGameId)) {
    data.meta.primaryGameId = data.games[0]?.id || "";
  }
  data.campaigns ||= [];
  data.creatorProfiles ||= [];
  data.creators ||= [];
  data.influencerKeys ||= [];
  data.steamDailyMetrics ||= [];
  data.outreachLogs ||= [];
  data.steamSyncState ||= {
    salesHighwatermark: "0",
    lastRunAt: "",
    lastStatus: "never_run",
    lastMessage: "",
  };
  data.integrationSettings ||= seeded.integrationSettings;
  data.integrationSettings.steamFinancialApiKeyEncrypted ||= "";
  data.integrationSettings.steamFinancialApiKeyMasked ||= "";
  data.integrationSettings.youtubeApiKeyEncrypted ||= "";
  data.integrationSettings.youtubeApiKeyMasked ||= "";
  data.integrationSettings.youtubeClientId ||= "";
  data.integrationSettings.youtubeClientSecretEncrypted ||= "";
  data.integrationSettings.youtubeClientSecretMasked ||= "";
  data.integrationSettings.youtubeRefreshTokenEncrypted ||= "";
  data.integrationSettings.youtubeAccessToken ||= "";
  data.integrationSettings.youtubeAccessTokenExpiry ||= 0;
  data.integrationSettings.youtubeOAuthConnectedAt ||= "";
  data.integrationSettings.youtubeOAuthState ||= "";
  data.integrationSettings.redditClientId ||= "";
  data.integrationSettings.redditClientSecretEncrypted ||= "";
  data.integrationSettings.redditClientSecretMasked ||= "";
  data.integrationSettings.redditAccessToken ||= "";
  data.integrationSettings.redditAccessTokenExpiry ||= 0;
  data.integrationSettings.smtpHost ||= "";
  data.integrationSettings.smtpPort = toNumber(data.integrationSettings.smtpPort, 587);
  data.integrationSettings.smtpUser ||= "";
  data.integrationSettings.smtpPassEncrypted ||= "";
  data.integrationSettings.smtpPassMasked ||= "";
  data.integrationSettings.smtpSecure = Boolean(data.integrationSettings.smtpSecure);
  data.integrationSettings.smtpStarttls = data.integrationSettings.smtpStarttls !== false;
  data.integrationSettings.emailFrom ||= "";
  data.integrationSettings.emailReplyTo ||= "";
  data.integrationSettings.emailSendMode ||= "smtp";
  data.integrationSettings.updatedAt ||= "";
  data.syncSchedule ||= seeded.syncSchedule;
  data.syncSchedule.enabled = Boolean(data.syncSchedule.enabled);
  data.syncSchedule.intervalHours = Math.max(1, Math.min(168, toNumber(data.syncSchedule.intervalHours, 24)));
  data.syncSchedule.gameId ||= "all";
  data.syncSchedule.includeWishlist = data.syncSchedule.includeWishlist !== false;
  data.syncSchedule.includeSales = Boolean(data.syncSchedule.includeSales);
  data.syncSchedule.includeViewGrants = Boolean(data.syncSchedule.includeViewGrants);
  data.syncSchedule.lookbackDays = Math.max(1, Math.min(14, toNumber(data.syncSchedule.lookbackDays, DEFAULT_SYNC_LOOKBACK_DAYS)));
  data.syncSchedule.startOffsetDays = Math.max(0, Math.min(30, toNumber(data.syncSchedule.startOffsetDays, 1)));
  data.syncSchedule.lastRunAt ||= "";
  data.syncSchedule.nextRunAt ||= "";
  data.syncSchedule.lastRunId ||= "";
  data.syncSchedule.lastStatus ||= "never_run";
  data.syncSchedule.lastMessage ||= "";
  data.syncRuns ||= [];
  data.youtubeChannels ||= [];
  data.youtubeSnapshots ||= [];
  data.redditPosts ||= [];
  for (const post of data.redditPosts) normalizeRedditPost(post);

  for (const game of data.games) {
    game.id ||= makeId("game", game.name || "game");
    game.name ||= "Untitled Game";
    game.shortName ||= game.name.slice(0, 2).toUpperCase();
    game.steamAppId = String(game.steamAppId || "0");
    game.stage ||= "concept";
    game.genre ||= "";
    game.launchDate ||= "";
    game.owner ||= "Growth";
    game.archived = Boolean(game.archived);
    game.status = game.archived ? "archived" : game.status || "active";
    game.imageUrl = sanitizeGameImage(game.imageUrl || "");
    if (!game.steamStoreUrl && game.steamAppId !== "0") game.steamStoreUrl = steamStoreUrl(game.steamAppId, game.name);
    game.createdAt ||= nowIso();
    game.updatedAt ||= game.createdAt;
  }

  for (const listing of data.storeListings) {
    normalizeStoreListing(data, listing);
  }

  for (const game of data.games) {
    upsertSteamListingFromGame(data, game);
  }

  for (const listing of data.storeListings) {
    normalizeStoreListing(data, listing);
  }

  for (const profile of data.creatorProfiles) {
    normalizeCreatorProfile(profile);
  }

  for (const creator of data.creators) {
    creator.tags = toList(creator.tags);
    creator.status = STATUS_OPTIONS.has(creator.status) ? creator.status : "uncontacted";
    creator.creatorProfileId ||= upsertCreatorProfile(data, creator).id;
  }

  for (const collection of [data.campaigns, data.creators, data.influencerKeys, data.steamDailyMetrics, data.outreachLogs]) {
    for (const record of collection) {
      record.gameId ||= data.meta.primaryGameId || data.games[0]?.id || "";
    }
  }
}

async function writeData(data) {
  ensureDb();
  persistData(data);
}

function encryptionKey() {
  return createHash("sha256").update(KEY_SECRET).digest();
}

function encryptSecret(value) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptSecret(value) {
  if (!value) return "";
  try {
    const [version, iv, tag, encrypted] = String(value).split(":");
    if (version !== "v1" || !iv || !tag || !encrypted) return "";
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function encryptSteamKey(value) {
  return encryptSecret(value);
}

function maskSecret(value) {
  if (!value) return "";
  const clean = String(value).trim();
  if (clean.length <= 8) return "configured";
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function maskSteamKey(value) {
  if (!value) return "";
  const clean = String(value).trim().toUpperCase();
  const parts = clean.split("-");
  if (parts.length >= 3) {
    return `${parts[0]}-****-${parts[parts.length - 1]}`;
  }
  if (clean.length <= 8) return "****";
  return `${clean.slice(0, 4)}****${clean.slice(-4)}`;
}

function sanitizeKey(record) {
  const { steamKeyEncrypted, ...safe } = record;
  return safe;
}

function activeGames(data) {
  return data.games.filter((game) => !game.archived);
}

function storeListingsForGame(data, gameId, options = {}) {
  return data.storeListings.filter((listing) => {
    if (listing.gameId !== gameId) return false;
    return options.includeArchived || listing.status !== "archived";
  });
}

function primaryStoreListing(data, gameId, platform = "steam") {
  const normalizedPlatform = normalizeStorePlatform(platform);
  return storeListingsForGame(data, gameId, { includeArchived: true }).find(
    (listing) => listing.platform === normalizedPlatform && listing.status !== "archived",
  );
}

function steamAppIdForGame(data, game) {
  const steamListing = primaryStoreListing(data, game.id, "steam");
  return String(steamListing?.externalId || game.steamAppId || "0");
}

function storeUrlForPlatform(data, gameId, platform = "steam") {
  const normalizedPlatform = normalizeStorePlatform(platform);
  const listing = primaryStoreListing(data, gameId, normalizedPlatform);
  if (listing?.storeUrl) return listing.storeUrl;
  const game = data.games.find((item) => item.id === gameId);
  if (normalizedPlatform === "steam" && game?.steamStoreUrl) return game.steamStoreUrl;
  return "";
}

function sanitizeStoreListing(data, listing) {
  return {
    ...listing,
    platformLabel: storePlatformLabel(listing.platform),
    gameName: gameNameFor(data, listing.gameId),
  };
}

function normalizeStoreListing(data, listing) {
  listing.id ||= makeId("listing", `${listing.gameId || "game"}_${listing.platform || "store"}`);
  listing.gameId ||= data.meta.primaryGameId || data.games[0]?.id || "";
  listing.platform = normalizeStorePlatform(listing.platform || listing.store || listing.channel || "steam");
  listing.platformLabel = storePlatformLabel(listing.platform);
  listing.externalId = String(
    listing.externalId || listing.appId || listing.appid || listing.steamAppId || listing.storeAppId || "",
  );
  listing.storeUrl = listing.storeUrl || listing.url || "";
  listing.dashboardUrl = listing.dashboardUrl || listing.adminUrl || "";
  listing.status = normalizeListingStatus(listing.status || (listing.archived ? "archived" : "draft"));
  listing.launchDate ||= "";
  listing.region ||= "global";
  listing.price ||= "";
  listing.currency ||= "";
  listing.notes = listing.notes || listing.note || "";
  listing.isPrimary = Boolean(listing.isPrimary);
  listing.createdAt ||= nowIso();
  listing.updatedAt ||= listing.createdAt;

  const game = data.games.find((item) => item.id === listing.gameId);
  if (listing.platform === "steam") {
    if (!listing.storeUrl && listing.externalId) listing.storeUrl = steamStoreUrl(listing.externalId, game?.name || "Game");
    if (game) {
      game.steamAppId = String(listing.externalId || game.steamAppId || "0");
      game.steamStoreUrl = listing.storeUrl || game.steamStoreUrl || steamStoreUrl(game.steamAppId, game.name);
    }
  }
  return listing;
}

function upsertSteamListingFromGame(data, game) {
  const appId = String(game.steamAppId || "0");
  const hasSteamSignal = (appId && appId !== "0") || validStoreUrl(game.steamStoreUrl || "");
  const existing = data.storeListings.find(
    (item) => item.gameId === game.id && normalizeStorePlatform(item.platform) === "steam",
  );
  if (!hasSteamSignal) {
    // Game has no Steam App ID / URL → keep tags consistent by archiving any stale Steam listing.
    if (existing && existing.status !== "archived") {
      existing.status = "archived";
      existing.updatedAt = nowIso();
    }
    return existing || null;
  }
  let listing = existing;
  if (!listing) {
    listing = {
      id: makeId("listing", `${game.id}_steam`),
      gameId: game.id,
      platform: "steam",
      createdAt: game.createdAt || nowIso(),
    };
    data.storeListings.push(listing);
  }
  listing.externalId = appId;
  listing.storeUrl = game.steamStoreUrl || listing.storeUrl || steamStoreUrl(appId, game.name);
  if (game.archived) {
    listing.status = "archived";
  } else if (!listing.status || listing.status === "archived") {
    // An active game with a Steam signal must surface an active listing (revive if archived).
    listing.status = game.stage === "launched" ? "live" : "draft";
  }
  listing.launchDate = game.launchDate || listing.launchDate || "";
  listing.updatedAt = game.updatedAt || nowIso();
  return normalizeStoreListing(data, listing);
}

function updateStoreListingFromInput(data, listing, input) {
  if (input.gameId !== undefined) listing.gameId = String(input.gameId);
  if (input.platform !== undefined) listing.platform = normalizeStorePlatform(input.platform);
  if (input.externalId !== undefined || input.appId !== undefined || input.steamAppId !== undefined) {
    listing.externalId = String(input.externalId || input.appId || input.steamAppId || "");
  }
  if (input.storeUrl !== undefined || input.url !== undefined) listing.storeUrl = input.storeUrl || input.url || "";
  if (input.dashboardUrl !== undefined || input.adminUrl !== undefined) listing.dashboardUrl = input.dashboardUrl || input.adminUrl || "";
  if (input.status !== undefined) listing.status = normalizeListingStatus(input.status);
  if (input.launchDate !== undefined) listing.launchDate = input.launchDate || "";
  if (input.region !== undefined) listing.region = input.region || "global";
  if (input.price !== undefined) listing.price = input.price || "";
  if (input.currency !== undefined) listing.currency = input.currency || "";
  if (input.notes !== undefined || input.note !== undefined) listing.notes = input.notes || input.note || "";
  if (input.isPrimary !== undefined) listing.isPrimary = Boolean(input.isPrimary);
  listing.updatedAt = nowIso();
  normalizeStoreListing(data, listing);
  return listing;
}

function respondJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function respondError(res, statusCode, message, details = undefined) {
  respondJson(res, statusCode, { error: message, details });
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2_000_000) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function buildUtmLink(data, input) {
  const game = gameFor(data, input.gameId || data.meta.primaryGameId || DEFAULT_GAME_ID);
  const platform = normalizeStorePlatform(input.platform || input.storePlatform || "steam");
  const listing = game ? primaryStoreListing(data, game.id, platform) || primaryStoreListing(data, game.id, "steam") : null;
  const appId = String(input.appId || listing?.externalId || game?.steamAppId || STEAM_APP_ID || "0");
  const baseUrl =
    input.baseUrl ||
    listing?.storeUrl ||
    (game ? storeUrlForPlatform(data, game.id, platform) : "") ||
    game?.steamStoreUrl ||
    steamStoreUrl(appId, game?.name || "Game");
  const url = new URL(baseUrl);
  const params = {
    utm_source: input.source || input.utm_source || "manual",
    utm_medium: input.medium || input.utm_medium || "influencer",
    utm_campaign: input.campaign || input.campaignId || input.utm_campaign || "launch_pilot",
    utm_content: input.content || input.creatorSlug || input.utm_content || "",
    utm_term: input.term || input.utm_term || "",
  };
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function aggregateMetrics(metrics) {
  return metrics.reduce(
    (sum, metric) => {
      sum.visits += toNumber(metric.visits);
      sum.wishlists += toNumber(metric.wishlists);
      sum.purchases += toNumber(metric.purchases);
      sum.revenue += toNumber(metric.revenue);
      sum.activations += toNumber(metric.activations);
      sum.refunds += toNumber(metric.refunds);
      return sum;
    },
    { visits: 0, wishlists: 0, purchases: 0, revenue: 0, activations: 0, refunds: 0 },
  );
}

function rate(part, whole) {
  if (!whole) return 0;
  return Number(((part / whole) * 100).toFixed(2));
}

function latestMetricDate(metrics) {
  const dates = metrics.map((metric) => metric.date).filter(Boolean).sort();
  return dates.at(-1) || new Date().toISOString().slice(0, 10);
}

function withinLastDays(dateString, anchorDateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const anchor = new Date(`${anchorDateString}T00:00:00Z`);
  const diff = anchor.getTime() - date.getTime();
  return diff >= 0 && diff <= (days - 1) * 24 * 60 * 60 * 1000;
}

function requestedGameId(url) {
  const value = url.searchParams.get("gameId") || "all";
  return value === "all" || value === "" ? "all" : value;
}

function scopedItems(items, gameId) {
  if (!gameId || gameId === "all") return items;
  return items.filter((item) => item.gameId === gameId);
}

function gameFor(data, gameId) {
  return data.games.find((game) => game.id === gameId) || data.games.find((game) => game.id === DEFAULT_GAME_ID) || data.games[0];
}

function gameNameFor(data, gameId) {
  return gameFor(data, gameId)?.name || "Unassigned Game";
}

function campaignNameFor(data, campaignId, fallback = "", gameId = "") {
  return (
    data.campaigns.find((campaign) => campaign.id === campaignId && (!gameId || campaign.gameId === gameId))?.name ||
    data.campaigns.find((campaign) => campaign.id === campaignId)?.name ||
    fallback ||
    campaignId ||
    "Unassigned"
  );
}

function buildPortfolio(data) {
  return data.games
    .map((game) => {
      const metrics = scopedItems(data.steamDailyMetrics, game.id);
      const campaigns = scopedItems(data.campaigns, game.id);
      const creators = scopedItems(data.creators, game.id);
      const keys = scopedItems(data.influencerKeys, game.id);
      const listings = storeListingsForGame(data, game.id, { includeArchived: true }).map((listing) =>
        sanitizeStoreListing(data, listing),
      );
      const totals = aggregateMetrics(metrics);
      const latestDate = latestMetricDate(metrics);
      const last7 = aggregateMetrics(metrics.filter((metric) => withinLastDays(metric.date, latestDate, 7)));
      return {
        ...game,
        storeListings: listings,
        activeStoreListings: listings.filter((listing) => listing.status !== "archived").length,
        platforms: listings
          .filter((listing) => listing.status !== "archived")
          .map((listing) => ({ key: listing.platform, label: listing.platformLabel, status: listing.status })),
        campaigns: campaigns.length,
        creators: creators.length,
        keys: keys.length,
        keysSent: keys.filter((key) => ["sent", "claimed", "video_uploaded"].includes(key.status)).length,
        visits: totals.visits,
        wishlists: totals.wishlists,
        purchases: totals.purchases,
        revenue: Number(totals.revenue.toFixed(2)),
        last7Wishlists: last7.wishlists,
        wishlistRate: rate(totals.wishlists, totals.visits),
        purchaseRate: rate(totals.purchases, totals.visits),
      };
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.wishlists - a.wishlists || b.purchases - a.purchases || a.name.localeCompare(b.name));
}

function buildDashboard(data, gameId = "all") {
  const metrics = scopedItems(data.steamDailyMetrics, gameId);
  const campaigns = scopedItems(data.campaigns, gameId);
  const creators = scopedItems(data.creators, gameId);
  const keys = scopedItems(data.influencerKeys, gameId);
  const latestDate = latestMetricDate(metrics);
  const todayMetrics = metrics.filter((metric) => metric.date === latestDate);
  const last7Metrics = metrics.filter((metric) => withinLastDays(metric.date, latestDate, 7));
  const today = aggregateMetrics(todayMetrics);
  const last7 = aggregateMetrics(last7Metrics);
  const campaignGroups = new Map();

  for (const metric of metrics) {
    const key = `${metric.gameId || DEFAULT_GAME_ID}:${metric.campaignId || metric.campaignName || "unassigned"}`;
    if (!campaignGroups.has(key)) {
      campaignGroups.set(key, {
        gameId: metric.gameId || DEFAULT_GAME_ID,
        gameName: gameNameFor(data, metric.gameId || DEFAULT_GAME_ID),
        campaignId: metric.campaignId || "",
        campaignName: campaignNameFor(data, metric.campaignId, metric.campaignName, metric.gameId),
        visits: 0,
        wishlists: 0,
        purchases: 0,
        revenue: 0,
        activations: 0,
        refunds: 0,
      });
    }
    const group = campaignGroups.get(key);
    group.visits += toNumber(metric.visits);
    group.wishlists += toNumber(metric.wishlists);
    group.purchases += toNumber(metric.purchases);
    group.revenue += toNumber(metric.revenue);
    group.activations += toNumber(metric.activations);
    group.refunds += toNumber(metric.refunds);
  }

  const topCampaigns = [...campaignGroups.values()]
    .map((campaign) => ({
      ...campaign,
      wishlistRate: rate(campaign.wishlists, campaign.visits),
      purchaseRate: rate(campaign.purchases, campaign.visits),
      revenue: Number(campaign.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.wishlists - a.wishlists || b.purchases - a.purchases)
    .slice(0, 8);

  const contactQueue = creators
    .filter((creator) => ["uncontacted", "drafted", "first_sent", "replied"].includes(creator.status))
    .sort((a, b) => toNumber(b.fitScore) - toNumber(a.fitScore))
    .slice(0, 12);

  return {
    latestDate,
    selectedGameId: gameId,
    selectedGameName: gameId === "all" ? "All Games" : gameNameFor(data, gameId),
    portfolio: buildPortfolio(data),
    today: {
      ...today,
      revenue: Number(today.revenue.toFixed(2)),
      wishlistRate: rate(today.wishlists, today.visits),
      purchaseRate: rate(today.purchases, today.visits),
    },
    last7: {
      ...last7,
      revenue: Number(last7.revenue.toFixed(2)),
      wishlistRate: rate(last7.wishlists, last7.visits),
      purchaseRate: rate(last7.purchases, last7.visits),
    },
    topCampaigns,
    contactQueue,
    summary: {
      games: activeGames(data).length,
      campaigns: campaigns.length,
      creators: creators.length,
      keys: keys.length,
      keysSent: keys.filter((key) => ["sent", "claimed", "video_uploaded"].includes(key.status)).length,
      videosUploaded: creators.filter((creator) => creator.status === "video_uploaded").length,
    },
  };
}

function campaignsWithMetrics(data, gameId = "all") {
  return scopedItems(data.campaigns, gameId).map((campaign) => {
    const metrics = data.steamDailyMetrics.filter((metric) => metric.campaignId === campaign.id && metric.gameId === campaign.gameId);
    const totals = aggregateMetrics(metrics);
    return {
      ...campaign,
      gameName: gameNameFor(data, campaign.gameId),
      metrics: {
        ...totals,
        revenue: Number(totals.revenue.toFixed(2)),
        wishlistRate: rate(totals.wishlists, totals.visits),
        purchaseRate: rate(totals.purchases, totals.visits),
      },
    };
  });
}

function validateCampaign(input) {
  if (!input.name || !String(input.name).trim()) {
    return "Campaign name is required.";
  }
  return "";
}

function validateCreator(input) {
  if (!(input.channelName || input.name) || !String(input.channelName || input.name).trim()) {
    return "Channel name is required.";
  }
  return "";
}

function creatorSlug(input) {
  return slugify(input.handle || input.channelName || input.name || input.email || "creator", "creator");
}

function normalizeCreatorProfile(profile) {
  profile.id ||= makeId("profile", profile.channelName || profile.handle || profile.email || "creator");
  profile.channelName ||= profile.name || profile.handle || profile.email || "Untitled Creator";
  profile.handle ||= creatorSlug(profile);
  profile.platform ||= "YouTube";
  profile.email ||= "";
  profile.country ||= "";
  profile.tags = toList(profile.tags || profile.niche);
  profile.subscribers = toNumber(profile.subscribers || profile.followers);
  profile.averageViews = toNumber(profile.averageViews);
  profile.fitScore = Math.max(0, Math.min(100, toNumber(profile.fitScore)));
  profile.status ||= "active";
  profile.note ||= "";
  profile.createdAt ||= nowIso();
  profile.updatedAt ||= profile.createdAt;
}

function findCreatorProfile(data, input = {}) {
  if (input.creatorProfileId) {
    const byId = data.creatorProfiles.find((profile) => profile.id === input.creatorProfileId);
    if (byId) return byId;
  }

  const email = String(input.email || input.recipientEmail || "").trim().toLowerCase();
  if (email) {
    const byEmail = data.creatorProfiles.find((profile) => String(profile.email || "").trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }

  const handle = String(input.handle || input.creatorHandle || "").trim().toLowerCase();
  const platform = String(input.platform || "YouTube").trim().toLowerCase();
  if (handle) {
    const byHandle = data.creatorProfiles.find(
      (profile) => String(profile.handle || "").trim().toLowerCase() === handle && String(profile.platform || "").trim().toLowerCase() === platform,
    );
    if (byHandle) return byHandle;
  }

  const channelName = String(input.channelName || input.name || input.recipientName || "").trim().toLowerCase();
  if (channelName) {
    return data.creatorProfiles.find((profile) => String(profile.channelName || "").trim().toLowerCase() === channelName);
  }
  return undefined;
}

function upsertCreatorProfile(data, input = {}) {
  data.creatorProfiles ||= [];
  const now = nowIso();
  const profile = findCreatorProfile(data, input);
  if (profile) {
    const incomingTags = toList(input.tags || input.niche);
    profile.channelName ||= input.channelName || input.name || input.recipientName || profile.channelName;
    profile.handle ||= input.handle || input.creatorHandle || creatorSlug(profile);
    profile.platform ||= input.platform || "YouTube";
    profile.email ||= input.email || input.recipientEmail || "";
    profile.country ||= input.country || "";
    profile.tags = [...new Set([...(profile.tags || []), ...incomingTags])];
    profile.subscribers ||= toNumber(input.subscribers || input.followers);
    profile.averageViews ||= toNumber(input.averageViews);
    profile.fitScore = Math.max(toNumber(profile.fitScore), Math.max(0, Math.min(100, toNumber(input.fitScore))));
    profile.note ||= input.note || input.notes || "";
    profile.updatedAt = now;
    normalizeCreatorProfile(profile);
    return profile;
  }

  const created = {
    id: input.id || makeId("profile", input.channelName || input.name || input.handle || input.email || "creator"),
    channelName: String(input.channelName || input.name || input.recipientName || input.handle || input.email || "Untitled Creator").trim(),
    handle: input.handle || input.creatorHandle || "",
    platform: input.platform || "YouTube",
    email: input.email || input.recipientEmail || "",
    country: input.country || "",
    tags: toList(input.tags || input.niche),
    subscribers: toNumber(input.subscribers || input.followers),
    averageViews: toNumber(input.averageViews),
    fitScore: Math.max(0, Math.min(100, toNumber(input.fitScore))),
    status: input.status || "active",
    note: input.note || input.notes || "",
    createdAt: now,
    updatedAt: now,
  };
  normalizeCreatorProfile(created);
  data.creatorProfiles.push(created);
  return created;
}

function creatorProfileStats(data, profile) {
  const outreach = data.creators.filter((creator) => creator.creatorProfileId === profile.id);
  const gameNames = [...new Set(outreach.map((creator) => gameNameFor(data, creator.gameId)).filter(Boolean))];
  const statuses = outreach.map((creator) => creator.status).filter(Boolean);
  const latest = outreach
    .map((creator) => creator.updatedAt || creator.createdAt || "")
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    outreachCount: outreach.length,
    gameNames,
    latestStatus: statuses.at(-1) || "",
    lastContactAt: latest || "",
  };
}

function creatorProfilesWithStats(data) {
  return data.creatorProfiles
    .map((profile) => ({
      ...profile,
      stats: creatorProfileStats(data, profile),
    }))
    .sort((a, b) => toNumber(b.fitScore) - toNumber(a.fitScore) || a.channelName.localeCompare(b.channelName));
}

function buildEmailDraft(data, input = {}) {
  const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
  const gameError = requireGame(data, gameId);
  if (gameError) throw new Error(gameError);
  const game = gameFor(data, gameId);
  const campaign = input.campaignId ? data.campaigns.find((item) => item.id === input.campaignId && item.gameId === gameId) : undefined;
  const creator =
    (input.creatorId ? data.creators.find((item) => item.id === input.creatorId) : undefined) ||
    (input.creatorProfileId ? data.creators.find((item) => item.creatorProfileId === input.creatorProfileId && item.gameId === gameId) : undefined);
  const profile =
    findCreatorProfile(data, {
      creatorProfileId: input.creatorProfileId || creator?.creatorProfileId,
      email: input.email || creator?.email,
      handle: input.handle || creator?.handle,
      channelName: input.channelName || creator?.channelName,
      platform: input.platform || creator?.platform,
    }) || (creator ? upsertCreatorProfile(data, creator) : undefined);

  if (!profile) throw new Error("크리에이터를 먼저 선택해야 합니다.");

  const contentSlug = creatorSlug(profile);
  const link =
    input.utmLink ||
    creator?.utmLink ||
    buildUtmLink(data, {
      gameId,
      source: String(profile.platform || "creator").toLowerCase(),
      medium: "creator_outreach",
      campaign: campaign?.id || slugify(campaign?.name || "creator_db"),
      content: contentSlug,
    });
  const subject = input.subject || `${game.name} Steam key for creator preview`;
  const greetingName = profile.channelName || profile.handle || "there";
  const body =
    input.body ||
    [
      `Hi ${greetingName},`,
      "",
      `I'm reaching out from the team behind ${game.name}. We thought your channel could be a strong fit, especially for viewers who like ${game.genre || "indie games"}.`,
      "",
      "We can send a Steam key if you would like to try it for a short impressions video or stream.",
      "",
      `Steam page: ${link}`,
      "",
      "No pressure either way. If it looks relevant to your audience, I would be happy to send over the key and a small press note.",
      "",
      "Thanks,",
      "Launch Pilot team",
    ].join("\n");
  const to = profile.email || creator?.email || "";
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return {
    to,
    subject,
    body,
    mailto,
    utmLink: link,
    gameId,
    campaignId: campaign?.id || input.campaignId || "",
    creatorId: creator?.id || input.creatorId || "",
    creatorProfileId: profile.id,
    creatorProfile: profile,
    creator,
    game,
    campaign,
  };
}

function effectiveIntegrationConfig(data) {
  const settings = data.integrationSettings || {};
  const storedSteamKey = decryptSecret(settings.steamFinancialApiKeyEncrypted);
  const storedYoutubeKey = decryptSecret(settings.youtubeApiKeyEncrypted);
  const storedYoutubeSecret = decryptSecret(settings.youtubeClientSecretEncrypted);
  const storedYoutubeRefresh = decryptSecret(settings.youtubeRefreshTokenEncrypted);
  const storedRedditSecret = decryptSecret(settings.redditClientSecretEncrypted);
  const storedSmtpPass = decryptSecret(settings.smtpPassEncrypted);
  const smtpUser = settings.smtpUser || SMTP_USER;
  return {
    steamFinancialApiKey: storedSteamKey || STEAM_FINANCIAL_API_KEY,
    steamKeySource: storedSteamKey ? "web" : STEAM_FINANCIAL_API_KEY ? "env" : "missing",
    smtpHost: settings.smtpHost || SMTP_HOST,
    smtpPort: toNumber(settings.smtpPort || SMTP_PORT, SMTP_PORT || 587),
    smtpUser,
    smtpPass: storedSmtpPass || SMTP_PASS,
    smtpSecure: settings.smtpSecure !== undefined ? Boolean(settings.smtpSecure) : SMTP_SECURE,
    smtpStarttls: settings.smtpStarttls !== undefined ? settings.smtpStarttls !== false : SMTP_STARTTLS,
    emailFrom: settings.emailFrom || EMAIL_FROM || smtpUser,
    emailReplyTo: settings.emailReplyTo || EMAIL_REPLY_TO,
    emailSendMode: settings.emailSendMode || EMAIL_SEND_MODE || "smtp",
    smtpSource: settings.smtpHost || settings.emailFrom || settings.smtpUser || storedSmtpPass ? "web" : SMTP_HOST || EMAIL_FROM ? "env" : "missing",
    steamKeyMasked: settings.steamFinancialApiKeyMasked || (STEAM_FINANCIAL_API_KEY ? maskSecret(STEAM_FINANCIAL_API_KEY) : ""),
    smtpPassMasked: settings.smtpPassMasked || (SMTP_PASS ? maskSecret(SMTP_PASS) : ""),
    youtubeApiKey: storedYoutubeKey || YOUTUBE_API_KEY,
    youtubeKeySource: storedYoutubeKey ? "web" : YOUTUBE_API_KEY ? "env" : "missing",
    youtubeKeyMasked: settings.youtubeApiKeyMasked || (YOUTUBE_API_KEY ? maskSecret(YOUTUBE_API_KEY) : ""),
    youtubeClientId: settings.youtubeClientId || "",
    youtubeClientSecret: storedYoutubeSecret,
    youtubeRefreshToken: storedYoutubeRefresh,
    youtubeOAuthConnected: Boolean(storedYoutubeRefresh),
    redditClientId: settings.redditClientId || "",
    redditClientSecret: storedRedditSecret,
    redditConfigured: Boolean(settings.redditClientId && storedRedditSecret),
  };
}

function publicSettings(data) {
  const settings = data.integrationSettings || {};
  const config = effectiveIntegrationConfig(data);
  return {
    steam: {
      configured: Boolean(config.steamFinancialApiKey),
      source: config.steamKeySource,
      keyMasked: config.steamKeyMasked,
    },
    youtube: {
      configured: Boolean(config.youtubeApiKey),
      source: config.youtubeKeySource,
      keyMasked: config.youtubeKeyMasked,
    },
    reddit: {
      configured: Boolean(config.redditClientId && config.redditClientSecret),
      clientId: config.redditClientId,
    },
    email: buildEmailStatus(data),
    form: {
      smtpHost: settings.smtpHost || "",
      smtpPort: settings.smtpPort || 587,
      smtpUser: settings.smtpUser || "",
      smtpSecure: Boolean(settings.smtpSecure),
      smtpStarttls: settings.smtpStarttls !== false,
      emailFrom: settings.emailFrom || "",
      emailReplyTo: settings.emailReplyTo || "",
      emailSendMode: settings.emailSendMode || "smtp",
      steamFinancialApiKeyMasked: settings.steamFinancialApiKeyMasked || "",
      smtpPassMasked: settings.smtpPassMasked || "",
      updatedAt: settings.updatedAt || "",
    },
  };
}

function updateIntegrationSettings(data, input = {}) {
  const settings = data.integrationSettings;
  if (input.clearSteamFinancialApiKey) {
    settings.steamFinancialApiKeyEncrypted = "";
    settings.steamFinancialApiKeyMasked = "";
  } else if (input.steamFinancialApiKey) {
    settings.steamFinancialApiKeyEncrypted = encryptSecret(input.steamFinancialApiKey);
    settings.steamFinancialApiKeyMasked = maskSecret(input.steamFinancialApiKey);
  }

  if (input.clearYoutubeApiKey) {
    settings.youtubeApiKeyEncrypted = "";
    settings.youtubeApiKeyMasked = "";
  } else if (input.youtubeApiKey) {
    settings.youtubeApiKeyEncrypted = encryptSecret(input.youtubeApiKey);
    settings.youtubeApiKeyMasked = maskSecret(input.youtubeApiKey);
  }

  if (input.youtubeClientId !== undefined) settings.youtubeClientId = String(input.youtubeClientId).trim();
  if (input.clearYoutubeClientSecret) {
    settings.youtubeClientSecretEncrypted = "";
    settings.youtubeClientSecretMasked = "";
  } else if (input.youtubeClientSecret) {
    settings.youtubeClientSecretEncrypted = encryptSecret(input.youtubeClientSecret);
    settings.youtubeClientSecretMasked = maskSecret(input.youtubeClientSecret);
  }

  if (input.redditClientId !== undefined) settings.redditClientId = String(input.redditClientId).trim();
  if (input.clearRedditClientSecret) {
    settings.redditClientSecretEncrypted = "";
    settings.redditClientSecretMasked = "";
    settings.redditAccessToken = "";
    settings.redditAccessTokenExpiry = 0;
  } else if (input.redditClientSecret) {
    settings.redditClientSecretEncrypted = encryptSecret(input.redditClientSecret);
    settings.redditClientSecretMasked = maskSecret(input.redditClientSecret);
    settings.redditAccessToken = "";
    settings.redditAccessTokenExpiry = 0;
  }

  if (input.clearSmtpPass) {
    settings.smtpPassEncrypted = "";
    settings.smtpPassMasked = "";
  } else if (input.smtpPass) {
    settings.smtpPassEncrypted = encryptSecret(input.smtpPass);
    settings.smtpPassMasked = maskSecret(input.smtpPass);
  }

  if (input.smtpHost !== undefined) settings.smtpHost = String(input.smtpHost).trim();
  if (input.smtpPort !== undefined) settings.smtpPort = toNumber(input.smtpPort, settings.smtpPort || 587);
  if (input.smtpUser !== undefined) settings.smtpUser = String(input.smtpUser).trim();
  if (input.smtpSecure !== undefined) settings.smtpSecure = input.smtpSecure === true || input.smtpSecure === "true" || input.smtpSecure === "on";
  if (input.smtpStarttls !== undefined) settings.smtpStarttls = input.smtpStarttls === true || input.smtpStarttls === "true" || input.smtpStarttls === "on";
  if (input.emailFrom !== undefined) settings.emailFrom = String(input.emailFrom).trim();
  if (input.emailReplyTo !== undefined) settings.emailReplyTo = String(input.emailReplyTo).trim();
  if (input.emailSendMode !== undefined) settings.emailSendMode = ["smtp", "log"].includes(input.emailSendMode) ? input.emailSendMode : "smtp";
  settings.updatedAt = nowIso();
  return publicSettings(data);
}

function emailConfigured(dataOrConfig) {
  const config = dataOrConfig?.smtpHost !== undefined ? dataOrConfig : effectiveIntegrationConfig(dataOrConfig || {});
  return Boolean(config.smtpHost && config.smtpPort && config.emailFrom);
}

function buildEmailStatus(data) {
  const config = effectiveIntegrationConfig(data || {});
  return {
    configured: emailConfigured(config),
    mode: config.emailSendMode,
    source: config.smtpSource,
    host: config.smtpHost ? config.smtpHost : "missing",
    port: config.smtpPort,
    from: config.emailFrom ? config.emailFrom : "missing",
    auth: config.smtpUser && config.smtpPass ? "configured" : "not_configured",
    secure: config.smtpSecure,
    starttls: config.smtpStarttls,
    passwordMasked: config.smtpPassMasked,
  };
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ""), "utf8").toString("base64")}?=`;
}

function addressOnly(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match ? match[1] : String(value || "")).trim();
}

function dotStuff(message) {
  return String(message).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function buildRawEmail({ from, to, replyTo, subject, body }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  return `${headers.join("\r\n")}\r\n\r\n${String(body || "").replace(/\r?\n/g, "\r\n")}`;
}

function smtpConnect(config) {
  return new Promise((resolve, reject) => {
    const options = {
      host: config.smtpHost,
      port: config.smtpPort,
      servername: config.smtpHost,
      timeout: 20_000,
    };
    const socket = config.smtpSecure ? tls.connect(options) : net.connect(options);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("SMTP connection timed out."));
    });
    socket.once("connect", () => resolve(socket));
    if (config.smtpSecure) {
      socket.once("secureConnect", () => resolve(socket));
    }
  });
}

function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (lines.some((line) => /^\d{3} /.test(line))) {
        cleanup();
        const last = lines.findLast((line) => /^\d{3} /.test(line)) || lines.at(-1);
        const code = Number(last.slice(0, 3));
        resolve({ code, lines, raw: buffer });
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function smtpCommand(socket, command, expected = [250]) {
  socket.write(`${command}\r\n`);
  const response = await readSmtpResponse(socket);
  if (!expected.includes(response.code)) {
    throw new Error(`SMTP command failed: ${command.split(" ")[0]} -> ${response.raw.trim()}`);
  }
  return response;
}

async function upgradeStartTls(socket, config) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect(
      {
        socket,
        servername: config.smtpHost,
      },
      () => resolve(secureSocket),
    );
    secureSocket.setEncoding("utf8");
    secureSocket.once("error", reject);
  });
}

async function sendEmailViaSmtp(config, { to, subject, body }) {
  if (!emailConfigured(config)) {
    throw new Error("SMTP_HOST, SMTP_PORT, EMAIL_FROM 설정이 필요합니다.");
  }
  let socket = await smtpConnect(config);
  try {
    await readSmtpResponse(socket);
    const ehlo = await smtpCommand(socket, "EHLO launch-pilot.local", [250]);
    const supportsStartTls = ehlo.raw.toUpperCase().includes("STARTTLS");
    if (!config.smtpSecure && config.smtpStarttls && supportsStartTls) {
      await smtpCommand(socket, "STARTTLS", [220]);
      socket = await upgradeStartTls(socket, config);
      await smtpCommand(socket, "EHLO launch-pilot.local", [250]);
    }
    if (config.smtpUser && config.smtpPass) {
      await smtpCommand(socket, "AUTH LOGIN", [334]);
      await smtpCommand(socket, Buffer.from(config.smtpUser, "utf8").toString("base64"), [334]);
      await smtpCommand(socket, Buffer.from(config.smtpPass, "utf8").toString("base64"), [235]);
    }
    await smtpCommand(socket, `MAIL FROM:<${addressOnly(config.emailFrom)}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${addressOnly(to)}>`, [250, 251]);
    await smtpCommand(socket, "DATA", [354]);
    socket.write(`${dotStuff(buildRawEmail({ from: config.emailFrom, to, replyTo: config.emailReplyTo, subject, body }))}\r\n.\r\n`);
    const dataResponse = await readSmtpResponse(socket);
    if (![250].includes(dataResponse.code)) {
      throw new Error(`SMTP DATA failed: ${dataResponse.raw.trim()}`);
    }
    await smtpCommand(socket, "QUIT", [221]);
    return { provider: "smtp", response: dataResponse.raw.trim() };
  } finally {
    socket.destroy();
  }
}

function addOutreachLog(data, input) {
  const log = {
    id: input.id || makeId("outreach", input.subject || input.to || "email"),
    gameId: input.gameId || "",
    creatorId: input.creatorId || "",
    creatorProfileId: input.creatorProfileId || "",
    campaignId: input.campaignId || "",
    channel: input.channel || "email",
    to: input.to || "",
    subject: input.subject || "",
    bodyPreview: String(input.body || "").slice(0, 240),
    status: input.status || "drafted",
    provider: input.provider || "",
    message: input.message || "",
    error: input.error || "",
    createdAt: nowIso(),
  };
  data.outreachLogs.unshift(log);
  data.outreachLogs = data.outreachLogs.slice(0, 500);
  return log;
}

function applyEmailSentEffects(data, log) {
  if (!["sent", "logged"].includes(log.status)) return;
  const creator = log.creatorId ? data.creators.find((item) => item.id === log.creatorId) : undefined;
  if (creator && ["uncontacted", "drafted"].includes(creator.status)) {
    creator.status = "first_sent";
    creator.updatedAt = nowIso();
  }
  const campaign = log.campaignId ? data.campaigns.find((item) => item.id === log.campaignId && (!log.gameId || item.gameId === log.gameId)) : undefined;
  if (campaign) {
    campaign.sentEmails = toNumber(campaign.sentEmails) + 1;
    campaign.updatedAt = nowIso();
  }
}

async function sendOutreachEmail(data, input = {}) {
  const draft = input.draft || buildEmailDraft(data, input);
  const config = effectiveIntegrationConfig(data);
  if (!draft.to) {
    const log = addOutreachLog(data, {
      ...draft,
      status: "blocked",
      provider: "none",
      message: "수신 이메일이 없습니다.",
    });
    return { status: "blocked", log, message: log.message };
  }
  if (config.emailSendMode === "log") {
    const log = addOutreachLog(data, {
      ...draft,
      status: "logged",
      provider: "log",
      message: "emailSendMode=log 로 발송 대신 로그 처리했습니다.",
    });
    applyEmailSentEffects(data, log);
    return { status: "logged", log, message: log.message };
  }
  if (!emailConfigured(config)) {
    const log = addOutreachLog(data, {
      ...draft,
      status: "blocked",
      provider: "smtp",
      message: "SMTP 설정이 없어 실제 발송하지 않았습니다.",
    });
    return { status: "blocked", log, message: log.message, emailStatus: buildEmailStatus(data) };
  }
  try {
    const result = await sendEmailViaSmtp(config, draft);
    const log = addOutreachLog(data, {
      ...draft,
      status: "sent",
      provider: result.provider,
      message: result.response,
    });
    applyEmailSentEffects(data, log);
    return { status: "sent", log, message: "메일을 발송했습니다." };
  } catch (error) {
    const log = addOutreachLog(data, {
      ...draft,
      status: "failed",
      provider: "smtp",
      error: error.message || "SMTP send failed.",
    });
    return { status: "failed", log, message: log.error };
  }
}

function validateKey(input) {
  if (!(input.recipientName || input.creatorHandle || input.recipientEmail || input.key || input.code || input.value || input.steamKey)) {
    return "Recipient name is required.";
  }
  return "";
}

function requireGame(data, gameId) {
  if (!gameId || !data.games.some((game) => game.id === gameId)) {
    return "먼저 게임을 추가하고 선택해야 합니다.";
  }
  return "";
}

function normalizeHeader(header) {
  return String(header).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const normalized = normalizeHeader(alias);
    if (row[normalized] !== undefined && row[normalized] !== "") {
      return row[normalized];
    }
  }
  return "";
}

function resolveGameId(data, input = {}, fallback = DEFAULT_GAME_ID) {
  const gameId = input.gameId || input.game_id;
  if (gameId && data.games.some((game) => game.id === gameId)) return gameId;
  const gameName = input.gameName || input.gamename || input.game;
  if (gameName) {
    const match = data.games.find((game) => game.name.toLowerCase() === String(gameName).toLowerCase());
    if (match) return match.id;
  }
  const appId = input.appId || input.appid || input.steamAppId || input.steamappid;
  if (appId) {
    const match = data.games.find((game) => String(game.steamAppId) === String(appId));
    if (match) return match.id;
  }
  if (fallback && fallback !== "all" && data.games.some((game) => game.id === fallback)) return fallback;
  return data.games[0]?.id || "";
}

function metricIdentity(metric) {
  return [metric.gameId, metric.date, metric.campaignId, metric.country, metric.source || "csv"].join("::");
}

function csvRowToMetric(data, row, defaultGameId = DEFAULT_GAME_ID, index = 0) {
  const date = firstValue(row, ["date", "day"]);
  const gameId = resolveGameId(
    data,
    {
      gameId: firstValue(row, ["gameId", "game_id"]),
      gameName: firstValue(row, ["gameName", "game", "title"]),
      appId: firstValue(row, ["appId", "appid", "steamAppId", "steam_app_id"]),
    },
    defaultGameId,
  );
  const gameError = requireGame(data, gameId);
  if (gameError) throw new Error(gameError);
  const campaignName = firstValue(row, ["campaignName", "campaign", "utm_campaign"]) || "Unassigned";
  const campaignId =
    firstValue(row, ["campaignId", "campaign_id"]) ||
    data.campaigns.find((campaign) => campaign.name === campaignName && campaign.gameId === gameId)?.id ||
    slugify(campaignName, "unassigned");
  if (!date) {
    throw new Error(`CSV row ${index + 1} is missing date.`);
  }

  return {
    id: makeId("metric", `${date}_${campaignId}_${firstValue(row, ["country", "region"]) || "global"}`),
    gameId,
    date,
    campaignId,
    campaignName,
    country: firstValue(row, ["country", "region", "territory"]) || "GLOBAL",
    visits: toNumber(firstValue(row, ["visits", "sessions", "storeVisits", "pageViews", "page_views"])),
    wishlists: toNumber(firstValue(row, ["wishlists", "wishlist", "wishlistAdds", "wishlistAdditions", "wishlist_additions", "adds"])),
    purchases: toNumber(firstValue(row, ["purchases", "sales", "units", "unitsSold", "units_sold", "copiesSold"])),
    revenue: toNumber(firstValue(row, ["revenue", "revenueUsd", "revenue_usd", "grossRevenue", "netRevenue"])),
    activations: toNumber(firstValue(row, ["activations", "keysActivated"])),
    refunds: toNumber(firstValue(row, ["refunds", "refund"])),
    source: "csv",
    createdAt: nowIso(),
  };
}

function previewSteamCsv(data, csvText, defaultGameId = DEFAULT_GAME_ID) {
  const rows = parseCsv(csvText);
  const columns = Object.keys(rows[0] || {});
  const existing = new Set(data.steamDailyMetrics.map((metric) => metricIdentity(metric)));
  const seen = new Set();
  const warnings = [];
  const records = [];
  let newRows = 0;
  let replaceRows = 0;
  let duplicateRows = 0;

  rows.forEach((row, index) => {
    try {
      const record = csvRowToMetric(data, row, defaultGameId, index);
      const identity = metricIdentity(record);
      if (seen.has(identity)) {
        duplicateRows += 1;
      } else if (existing.has(identity)) {
        replaceRows += 1;
      } else {
        newRows += 1;
      }
      seen.add(identity);
      records.push({
        ...record,
        gameName: gameNameFor(data, record.gameId),
      });
    } catch (error) {
      warnings.push(error.message || `CSV row ${index + 1} is invalid.`);
    }
  });

  return {
    columns,
    totalRows: rows.length,
    newRows,
    replaceRows,
    duplicateRows,
    warnings,
    previewRows: records.slice(0, 8),
  };
}

function importSteamCsv(data, csvText, defaultGameId = DEFAULT_GAME_ID) {
  const rows = parseCsv(csvText);
  let imported = 0;
  let replaced = 0;
  let skippedDuplicates = 0;
  const seen = new Set();

  rows.forEach((row, index) => {
    const record = csvRowToMetric(data, row, defaultGameId, index);
    const identity = metricIdentity(record);
    if (seen.has(identity)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(identity);

    const existingIndex = data.steamDailyMetrics.findIndex((metric) => metricIdentity(metric) === identity);
    if (existingIndex >= 0) {
      data.steamDailyMetrics[existingIndex] = record;
      replaced += 1;
    } else {
      data.steamDailyMetrics.push(record);
      imported += 1;
    }
  });

  data.steamDailyMetrics.sort((a, b) => a.date.localeCompare(b.date));
  return { imported, replaced, skippedDuplicates, totalRows: rows.length };
}

function creatorInputFromCsvRow(row, index = 0) {
  const channelName =
    firstValue(row, ["channelName", "channel", "name", "creator", "creatorName"]) ||
    firstValue(row, ["handle", "username"]) ||
    firstValue(row, ["email", "mail"]);
  if (!channelName) {
    throw new Error(`Creator CSV row ${index + 1} is missing channelName/name/handle/email.`);
  }
  return {
    channelName,
    handle: firstValue(row, ["handle", "username", "slug"]),
    platform: firstValue(row, ["platform", "site"]) || "YouTube",
    email: firstValue(row, ["email", "mail", "contact"]),
    country: firstValue(row, ["country", "region"]),
    tags: firstValue(row, ["tags", "niche", "genre"]),
    subscribers: firstValue(row, ["subscribers", "followers", "subs"]),
    averageViews: firstValue(row, ["averageViews", "avgViews", "average_views", "views"]),
    fitScore: firstValue(row, ["fitScore", "score", "fit_score"]),
    status: firstValue(row, ["status"]) || "active",
    note: firstValue(row, ["note", "notes"]),
  };
}

function creatorProfilePreviewIdentity(input) {
  const email = String(input.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const handle = String(input.handle || "").trim().toLowerCase();
  if (handle) return `handle:${String(input.platform || "").trim().toLowerCase()}:${handle}`;
  return `name:${String(input.channelName || "").trim().toLowerCase()}`;
}

function previewCreatorCsv(data, csvText) {
  const rows = parseCsv(csvText);
  const columns = Object.keys(rows[0] || {});
  const seen = new Set();
  let newRows = 0;
  let updateRows = 0;
  let duplicateRows = 0;
  const warnings = [];
  const previewRows = [];

  rows.forEach((row, index) => {
    try {
      const input = creatorInputFromCsvRow(row, index);
      const identity = creatorProfilePreviewIdentity(input);
      if (seen.has(identity)) {
        duplicateRows += 1;
      } else if (findCreatorProfile(data, input)) {
        updateRows += 1;
      } else {
        newRows += 1;
      }
      seen.add(identity);
      previewRows.push({
        ...input,
        tags: toList(input.tags),
        subscribers: toNumber(input.subscribers),
        averageViews: toNumber(input.averageViews),
        fitScore: toNumber(input.fitScore),
      });
    } catch (error) {
      warnings.push(error.message || `Creator CSV row ${index + 1} is invalid.`);
    }
  });

  return {
    columns,
    totalRows: rows.length,
    newRows,
    updateRows,
    duplicateRows,
    warnings,
    previewRows: previewRows.slice(0, 8),
  };
}

function importCreatorCsv(data, csvText) {
  const rows = parseCsv(csvText);
  const seen = new Set();
  let imported = 0;
  let updated = 0;
  let skippedDuplicates = 0;

  rows.forEach((row, index) => {
    const input = creatorInputFromCsvRow(row, index);
    const identity = creatorProfilePreviewIdentity(input);
    if (seen.has(identity)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(identity);
    const existed = Boolean(findCreatorProfile(data, input));
    upsertCreatorProfile(data, input);
    if (existed) updated += 1;
    else imported += 1;
  });

  return { imported, updated, skippedDuplicates, totalRows: rows.length };
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return toDateString(date);
}

function dateRange(startDate, endDate, maxDays = 14) {
  // Blank dates default to the last DEFAULT_SYNC_LOOKBACK_DAYS days ending yesterday
  // (a single-day "yesterday only" default was easy to mistake for missing data).
  const end = endDate || addDays(toDateString(new Date()), -1);
  const start = startDate || addDays(end, -(DEFAULT_SYNC_LOOKBACK_DAYS - 1));
  const dates = [];
  let cursor = start;
  while (cursor <= end && dates.length < maxDays) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function gamesForSync(data, gameId) {
  const games = scopedItems(data.games, gameId || "all").filter((game) => {
    const appId = steamAppIdForGame(data, game);
    return !game.archived && appId && appId !== "0";
  });
  return games;
}

function upsertMetric(data, record) {
  const existingIndex = data.steamDailyMetrics.findIndex(
    (metric) =>
      metric.gameId === record.gameId &&
      metric.date === record.date &&
      metric.campaignId === record.campaignId &&
      metric.country === record.country &&
      metric.source === record.source,
  );
  if (existingIndex >= 0) {
    data.steamDailyMetrics[existingIndex] = {
      ...data.steamDailyMetrics[existingIndex],
      ...record,
      updatedAt: nowIso(),
    };
    return "updated";
  }
  data.steamDailyMetrics.push(record);
  return "inserted";
}

async function steamGet(pathname, params) {
  const url = new URL(`${STEAM_API_BASE}/${pathname}/v001/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || body?.response?.error || `Steam API ${pathname} failed with ${response.status}`);
  }
  return body?.response || body || {};
}

function wishlistSummaryToMetric(game, date, country, summary, source = "steam_wishlist_api") {
  return {
    id: makeId("metric", `${game.id}_${date}_${source}_${country}`),
    gameId: game.id,
    date,
    campaignId: "steam_api_wishlist",
    campaignName: "Steam Wishlist API",
    country,
    visits: 0,
    wishlists: toNumber(summary?.wishlist_adds),
    purchases: toNumber(summary?.wishlist_purchases),
    revenue: 0,
    activations: 0,
    refunds: toNumber(summary?.wishlist_deletes),
    source,
    createdAt: nowIso(),
  };
}

async function syncWishlistForGame(data, game, dates, run) {
  const apiKey = effectiveIntegrationConfig(data).steamFinancialApiKey;
  let inserted = 0;
  let updated = 0;
  for (const date of dates) {
    const response = await steamGet("GetAppWishlistReporting", {
      key: apiKey,
      appid: game.steamAppId,
      date,
    });
    const countrySummary = Array.isArray(response.country_summary) ? response.country_summary : [];
    const rows = countrySummary.length
      ? countrySummary.map((entry) => ({
          country: entry.country_code || "GLOBAL",
          summary: entry.summary_actions || {},
        }))
      : [{ country: "GLOBAL", summary: response.wishlist_summary || {} }];

    for (const row of rows) {
      const result = upsertMetric(data, wishlistSummaryToMetric(game, date, row.country, row.summary));
      if (result === "inserted") inserted += 1;
      if (result === "updated") updated += 1;
    }
    run.events.push({ type: "wishlist", gameId: game.id, date, rows: rows.length });
  }
  return { inserted, updated };
}

function salesRecordBelongsToGame(record, game) {
  const appIds = [record.primary_appid, record.appid].filter((value) => value !== undefined && value !== null);
  return appIds.some((appid) => String(appid) === String(game.steamAppId));
}

function salesRecordsToMetrics(data, date, records) {
  const groups = new Map();
  for (const record of records) {
    const game = data.games.find((item) => salesRecordBelongsToGame(record, item));
    if (!game) continue;
    const country = record.country_code || "GLOBAL";
    const key = `${game.id}:${date}:${country}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: makeId("metric", `${game.id}_${date}_steam_sales_api_${country}`),
        gameId: game.id,
        date,
        campaignId: "steam_api_sales",
        campaignName: "Steam Sales API",
        country,
        visits: 0,
        wishlists: 0,
        purchases: 0,
        revenue: 0,
        activations: 0,
        refunds: 0,
        source: "steam_sales_api",
        createdAt: nowIso(),
      });
    }
    const metric = groups.get(key);
    metric.purchases += toNumber(record.net_units_sold || record.gross_units_sold);
    metric.refunds += Math.abs(toNumber(record.gross_units_returned));
    metric.revenue += toNumber(record.net_sales_usd || record.gross_sales_usd);
    metric.activations += toNumber(record.gross_units_activated);
  }
  return [...groups.values()].map((metric) => ({
    ...metric,
    revenue: Number(metric.revenue.toFixed(2)),
  }));
}

async function syncSales(data, run, includeViewGrants = false) {
  const apiKey = effectiveIntegrationConfig(data).steamFinancialApiKey;
  const changed = await steamGet("GetChangedDatesForPartner", {
    key: apiKey,
    highwatermark: data.steamSyncState.salesHighwatermark || "0",
    include_view_grants: includeViewGrants ? 1 : 0,
  });
  const dates = Array.isArray(changed.dates) ? changed.dates.map((date) => String(date).replaceAll("/", "-")) : [];
  let inserted = 0;
  let updated = 0;
  for (const date of dates) {
    let highwatermarkId = "0";
    let guard = 0;
    do {
      const detailed = await steamGet("GetDetailedSales", {
        key: apiKey,
        date,
        highwatermark_id: highwatermarkId,
        include_view_grants: includeViewGrants ? 1 : 0,
      });
      const records = Array.isArray(detailed.results) ? detailed.results : [];
      for (const metric of salesRecordsToMetrics(data, date, records)) {
        const result = upsertMetric(data, metric);
        if (result === "inserted") inserted += 1;
        if (result === "updated") updated += 1;
      }
      const nextHighwatermark = String(detailed.max_id || highwatermarkId);
      if (nextHighwatermark === highwatermarkId) break;
      highwatermarkId = nextHighwatermark;
      guard += 1;
    } while (guard < 50);
    run.events.push({ type: "sales", date });
  }
  if (changed.result_highwatermark) {
    data.steamSyncState.salesHighwatermark = String(changed.result_highwatermark);
  }
  return { inserted, updated, changedDates: dates.length };
}

async function runSteamSync(data, input) {
  const apiKey = effectiveIntegrationConfig(data).steamFinancialApiKey;
  const run = {
    id: makeId("sync", input.gameId || "all"),
    startedAt: nowIso(),
    finishedAt: "",
    status: "running",
    dryRun: Boolean(input.dryRun),
    gameId: input.gameId || "all",
    includeWishlist: input.includeWishlist !== false,
    includeSales: Boolean(input.includeSales),
    startDate: input.startDate || "",
    endDate: input.endDate || "",
    inserted: 0,
    updated: 0,
    warnings: [],
    events: [],
  };

  const dates = dateRange(input.startDate, input.endDate, 14);
  const games = gamesForSync(data, run.gameId);

  if (!games.length) {
    run.warnings.push("Steam App ID가 설정된 게임이 없습니다.");
  }

  if (!apiKey) {
    run.status = "blocked";
    run.warnings.push("Steam API Key가 없습니다. Settings에서 Steam Financial API Key를 저장하세요.");
  } else if (run.dryRun) {
    run.status = "planned";
  } else {
    try {
      if (run.includeWishlist) {
        for (const game of games) {
          const result = await syncWishlistForGame(data, game, dates, run);
          run.inserted += result.inserted;
          run.updated += result.updated;
        }
      }
      if (run.includeSales) {
        const result = await syncSales(data, run, Boolean(input.includeViewGrants));
        run.inserted += result.inserted;
        run.updated += result.updated;
        run.changedDates = result.changedDates;
      }
      run.status = "completed";
    } catch (error) {
      run.status = "failed";
      run.warnings.push(error.message || "Steam sync failed.");
    }
  }

  if (run.status === "planned") {
    run.events = games.flatMap((game) =>
      dates.map((date) => ({
        type: "wishlist_plan",
        gameId: game.id,
        appid: game.steamAppId,
        date,
      })),
    );
    if (run.includeSales) run.events.push({ type: "sales_plan", highwatermark: data.steamSyncState.salesHighwatermark || "0" });
  }

  run.finishedAt = nowIso();
  data.steamSyncState.lastRunAt = run.finishedAt;
  data.steamSyncState.lastStatus = run.status;
  data.steamSyncState.lastMessage = run.warnings[0] || `${run.inserted} inserted, ${run.updated} updated`;
  data.syncRuns.unshift(run);
  data.syncRuns = data.syncRuns.slice(0, 20);
  return run;
}

function buildSteamSyncStatus(data) {
  const gamesWithAppIds = data.games.filter((game) => !game.archived && steamAppIdForGame(data, game) !== "0");
  const config = effectiveIntegrationConfig(data);
  return {
    configured: Boolean(config.steamFinancialApiKey),
    keyEnv: config.steamKeySource === "missing" ? "missing" : config.steamKeySource,
    keyMasked: config.steamKeyMasked,
    gamesWithAppIds: gamesWithAppIds.length,
    totalGames: activeGames(data).length,
    salesHighwatermark: data.steamSyncState.salesHighwatermark || "0",
    lastRunAt: data.steamSyncState.lastRunAt || "",
    lastStatus: data.steamSyncState.lastStatus || "never_run",
    lastMessage: data.steamSyncState.lastMessage || "",
    recentRuns: data.syncRuns.slice(0, 8),
  };
}

function validStoreUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function latestSyncRunForGame(data, gameId) {
  return (
    data.syncRuns.find((run) => run.gameId === gameId) ||
    data.syncRuns.find((run) => run.gameId === "all" && (run.events || []).some((event) => event.gameId === gameId)) ||
    null
  );
}

function gameReadiness(data, game) {
  const config = effectiveIntegrationConfig(data);
  const metrics = scopedItems(data.steamDailyMetrics, game.id);
  const campaigns = scopedItems(data.campaigns, game.id);
  const creators = scopedItems(data.creators, game.id);
  const keys = scopedItems(data.influencerKeys, game.id);
  const latestSync = latestSyncRunForGame(data, game.id);
  const listings = storeListingsForGame(data, game.id);
  const steamListing = primaryStoreListing(data, game.id, "steam");
  const steamExpected = Boolean(steamListing || (game.steamAppId && game.steamAppId !== "0"));
  const hasStoreUrl = listings.some((listing) => validStoreUrl(listing.storeUrl));
  const checks = [
    { key: "storeListing", label: "Store Listing", ok: hasStoreUrl },
    // Steam-specific checks only apply when the game actually targets Steam (has an App ID / Steam listing).
    { key: "appId", label: "Steam App ID", ok: steamAppIdForGame(data, game) !== "0", applicable: steamExpected },
    { key: "apiKey", label: "Steam API Key", ok: Boolean(config.steamFinancialApiKey), applicable: steamExpected },
    { key: "campaign", label: "Campaign", ok: campaigns.length > 0 },
    { key: "creator", label: "Creator", ok: creators.length > 0 },
    { key: "utm", label: "UTM", ok: creators.some((creator) => creator.utmLink) || metrics.some((metric) => metric.campaignId && !metric.campaignId.startsWith("steam_api_")) },
    { key: "metrics", label: "Metrics", ok: metrics.length > 0 },
    { key: "keys", label: "Key Records", ok: keys.length > 0 },
  ];
  const applicableChecks = checks.filter((check) => check.applicable !== false);
  const readyCount = applicableChecks.filter((check) => check.ok).length;
  const score = applicableChecks.length ? Math.round((readyCount / applicableChecks.length) * 100) : 0;
  return {
    gameId: game.id,
    gameName: game.name,
    stage: game.stage,
    archived: Boolean(game.archived),
    steamAppId: steamAppIdForGame(data, game),
    steamStoreUrl: game.steamStoreUrl,
    storeListings: listings.map((listing) => sanitizeStoreListing(data, listing)),
    platforms: listings.map((listing) => ({ key: listing.platform, label: listing.platformLabel, status: listing.status })),
    readyCount,
    totalChecks: applicableChecks.length,
    score,
    status: score === 100 ? "ready" : score >= 60 ? "partial" : "setup",
    checks,
    counts: {
      campaigns: campaigns.length,
      creators: creators.length,
      keys: keys.length,
      metrics: metrics.length,
    },
    latestMetricDate: metrics.length ? latestMetricDate(metrics) : "",
    latestSync,
  };
}

function buildReadiness(data) {
  const config = effectiveIntegrationConfig(data);
  const games = activeGames(data).map((game) => gameReadiness(data, game));
  const readyGames = games.filter((game) => game.status === "ready").length;
  return {
    generatedAt: nowIso(),
    apiKeyConfigured: Boolean(config.steamFinancialApiKey),
    games,
    summary: {
      games: games.length,
      readyGames,
      partialGames: games.filter((game) => game.status === "partial").length,
      setupGames: games.filter((game) => game.status === "setup").length,
    },
  };
}

// ---------------------------------------------------------------------------
// YouTube (public stats via YouTube Data API v3)
// ---------------------------------------------------------------------------
async function youtubeGet(path, params) {
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `YouTube API ${path} 호출 실패 (${response.status})`);
  }
  return body || {};
}

function parseChannelRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/youtube\.com|youtu\.be/i.test(raw)) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel" && parts[1]) return { type: "id", value: parts[1] };
      if (parts[0] && parts[0].startsWith("@")) return { type: "handle", value: parts[0] };
      if (parts[0] === "user" && parts[1]) return { type: "username", value: parts[1] };
      if (parts[0] === "c" && parts[1]) return { type: "handle", value: `@${parts[1]}` };
    } catch {
      /* fall through */
    }
  }
  if (/^UC[\w-]{20,}$/.test(raw)) return { type: "id", value: raw };
  if (raw.startsWith("@")) return { type: "handle", value: raw };
  return { type: "handle", value: `@${raw}` };
}

async function fetchYoutubeChannel(apiKey, ref) {
  const params = { part: "snippet,statistics,contentDetails", key: apiKey, maxResults: 1 };
  if (ref.type === "id") params.id = ref.value;
  else if (ref.type === "handle") params.forHandle = ref.value;
  else if (ref.type === "username") params.forUsername = ref.value;
  const data = await youtubeGet("channels", params);
  const item = data.items && data.items[0];
  if (!item) throw new Error("채널을 찾지 못했습니다. 채널 ID(UC...) 또는 핸들(@name)을 확인하세요.");
  return item;
}

async function fetchYoutubeRecentVideos(apiKey, uploadsPlaylistId, max = 8) {
  if (!uploadsPlaylistId) return [];
  const playlist = await youtubeGet("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: max,
    key: apiKey,
  });
  const ids = (playlist.items || []).map((entry) => entry.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const videos = await youtubeGet("videos", { part: "snippet,statistics", id: ids.join(","), key: apiKey });
  return (videos.items || []).map((video) => ({
    id: video.id,
    title: video.snippet?.title || "",
    publishedAt: video.snippet?.publishedAt || "",
    thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || "",
    views: toNumber(video.statistics?.viewCount),
    likes: toNumber(video.statistics?.likeCount),
    comments: toNumber(video.statistics?.commentCount),
  }));
}

function applyYoutubeChannelStats(channel, item) {
  channel.channelId = item.id || channel.channelId;
  channel.title = item.snippet?.title || channel.title || "";
  channel.handle = item.snippet?.customUrl || channel.handle || "";
  channel.thumbnail =
    item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url || channel.thumbnail || "";
  channel.uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads || channel.uploadsPlaylistId || "";
  channel.hiddenSubscriberCount = Boolean(item.statistics?.hiddenSubscriberCount);
  channel.subscribers = toNumber(item.statistics?.subscriberCount);
  channel.views = toNumber(item.statistics?.viewCount);
  channel.videoCount = toNumber(item.statistics?.videoCount);
  return channel;
}

function upsertYoutubeSnapshot(data, channel, date) {
  const snapshot = {
    channelId: channel.channelId,
    date,
    subscribers: channel.subscribers,
    views: channel.views,
    videoCount: channel.videoCount,
  };
  const index = data.youtubeSnapshots.findIndex((item) => item.channelId === channel.channelId && item.date === date);
  if (index >= 0) data.youtubeSnapshots[index] = { ...data.youtubeSnapshots[index], ...snapshot };
  else data.youtubeSnapshots.push(snapshot);
}

async function syncYoutubeChannels(data, channelId = "all") {
  const apiKey = effectiveIntegrationConfig(data).youtubeApiKey;
  if (!apiKey) throw new Error("YouTube API Key가 없습니다. 먼저 키를 저장하세요.");
  const targets = data.youtubeChannels.filter(
    (channel) => channelId === "all" || channel.id === channelId || channel.channelId === channelId,
  );
  const date = toDateString(new Date());
  const warnings = [];
  let synced = 0;
  for (const channel of targets) {
    try {
      const item = await fetchYoutubeChannel(apiKey, { type: "id", value: channel.channelId });
      applyYoutubeChannelStats(channel, item);
      channel.recentVideos = await fetchYoutubeRecentVideos(apiKey, channel.uploadsPlaylistId);
      channel.lastSyncedAt = nowIso();
      upsertYoutubeSnapshot(data, channel, date);
      synced += 1;
    } catch (error) {
      warnings.push(`${channel.title || channel.channelId}: ${error.message}`);
    }
  }
  return { synced, total: targets.length, warnings };
}

// ---- YouTube Analytics (OAuth-protected, owner-only metrics) ----
function youtubeOAuthRedirectUri(url) {
  return `${url.protocol}//${url.host}/api/youtube/oauth/callback`;
}

function buildGoogleAuthUrl(clientId, redirectUri, state) {
  const authUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", YOUTUBE_OAUTH_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return authUrl.toString();
}

async function googleTokenRequest(params) {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error_description || body?.error || `Google OAuth 토큰 요청 실패 (${response.status})`);
  }
  return body;
}

async function ensureYoutubeAccessToken(data) {
  const settings = data.integrationSettings;
  const config = effectiveIntegrationConfig(data);
  if (!config.youtubeOAuthConnected) throw new Error("Google 계정이 연결되지 않았습니다.");
  if (settings.youtubeAccessToken && settings.youtubeAccessTokenExpiry && Date.now() < settings.youtubeAccessTokenExpiry - 60000) {
    return settings.youtubeAccessToken;
  }
  const refreshed = await googleTokenRequest({
    client_id: config.youtubeClientId,
    client_secret: config.youtubeClientSecret,
    refresh_token: config.youtubeRefreshToken,
    grant_type: "refresh_token",
  });
  settings.youtubeAccessToken = refreshed.access_token || "";
  settings.youtubeAccessTokenExpiry = Date.now() + toNumber(refreshed.expires_in, 3600) * 1000;
  return settings.youtubeAccessToken;
}

async function youtubeAnalyticsQuery(token, channelId, params) {
  const url = new URL(YOUTUBE_ANALYTICS_BASE);
  url.searchParams.set("ids", `channel==${channelId}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `YouTube Analytics 호출 실패 (${response.status})`);
  }
  return body;
}

function analyticsRows(report) {
  const headers = (report.columnHeaders || []).map((header) => header.name);
  return (report.rows || []).map((row) => {
    const obj = {};
    headers.forEach((name, index) => {
      obj[name] = row[index];
    });
    return obj;
  });
}

async function buildYoutubeAnalytics(data, channelId, days = 28) {
  const token = await ensureYoutubeAccessToken(data);
  const span = Math.max(1, Math.min(365, toNumber(days, 28)));
  const endDate = addDays(toDateString(new Date()), -1);
  const startDate = addDays(endDate, -(span - 1));
  const range = { startDate, endDate };

  const daily = analyticsRows(
    await youtubeAnalyticsQuery(token, channelId, {
      ...range,
      dimensions: "day",
      metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
      sort: "day",
    }),
  );
  const countries = analyticsRows(
    await youtubeAnalyticsQuery(token, channelId, {
      ...range,
      dimensions: "country",
      metrics: "views,estimatedMinutesWatched",
      sort: "-views",
      maxResults: 10,
    }),
  );
  const trafficSources = analyticsRows(
    await youtubeAnalyticsQuery(token, channelId, {
      ...range,
      dimensions: "insightTrafficSourceType",
      metrics: "views,estimatedMinutesWatched",
      sort: "-views",
    }),
  );
  const topVideos = analyticsRows(
    await youtubeAnalyticsQuery(token, channelId, {
      ...range,
      dimensions: "video",
      metrics: "views,estimatedMinutesWatched,averageViewPercentage",
      sort: "-views",
      maxResults: 10,
    }),
  );

  const apiKey = effectiveIntegrationConfig(data).youtubeApiKey;
  if (apiKey && topVideos.length) {
    try {
      const ids = topVideos.map((video) => video.video).filter(Boolean).join(",");
      const meta = await youtubeGet("videos", { part: "snippet", id: ids, key: apiKey });
      const titles = Object.fromEntries((meta.items || []).map((item) => [item.id, item.snippet?.title || item.id]));
      for (const video of topVideos) video.title = titles[video.video] || video.video;
    } catch {
      for (const video of topVideos) video.title = video.video;
    }
  } else {
    for (const video of topVideos) video.title = video.video;
  }

  const totals = daily.reduce(
    (acc, row) => {
      acc.views += Number(row.views || 0);
      acc.minutes += Number(row.estimatedMinutesWatched || 0);
      acc.gained += Number(row.subscribersGained || 0);
      acc.lost += Number(row.subscribersLost || 0);
      return acc;
    },
    { views: 0, minutes: 0, gained: 0, lost: 0 },
  );
  totals.netSubs = totals.gained - totals.lost;
  totals.avgViewDuration = daily.length
    ? Math.round(daily.reduce((sum, row) => sum + Number(row.averageViewDuration || 0), 0) / daily.length)
    : 0;

  return { range, days: span, totals, daily, countries, trafficSources, topVideos };
}

// ---------------------------------------------------------------------------
// Reddit post log (manual record + clever batched public-JSON stat fetch)
// ---------------------------------------------------------------------------
function parseRedditPostId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let match = raw.match(/redd\.it\/([a-z0-9]+)/i);
  if (match) return match[1].toLowerCase();
  match = raw.match(/comments\/([a-z0-9]+)/i);
  if (match) return match[1].toLowerCase();
  match = raw.match(/^(?:t3_)?([a-z0-9]{4,10})$/i);
  if (match) return match[1].toLowerCase();
  return "";
}

async function ensureRedditToken(data) {
  const settings = data.integrationSettings;
  const config = effectiveIntegrationConfig(data);
  if (!config.redditClientId || !config.redditClientSecret) return "";
  if (settings.redditAccessToken && settings.redditAccessTokenExpiry && Date.now() < settings.redditAccessTokenExpiry - 60000) {
    return settings.redditAccessToken;
  }
  const auth = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString("base64");
  const response = await fetch(REDDIT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error || body?.message || `Reddit 토큰 발급 실패 (${response.status})`);
  }
  settings.redditAccessToken = body.access_token;
  settings.redditAccessTokenExpiry = Date.now() + toNumber(body.expires_in, 3600) * 1000;
  return settings.redditAccessToken;
}

// Fetch many posts in a SINGLE request via Reddit's by_id endpoint. Uses app-only
// OAuth (oauth.reddit.com) when client credentials are configured — reliable from
// servers — otherwise best-effort anonymous (often 403 from datacenter IPs).
async function redditFetchByIds(data, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return { byId: {}, warning: "" };
  const names = unique.map((id) => `t3_${id}`).join(",");
  const config = effectiveIntegrationConfig(data);
  let token = "";
  if (config.redditClientId && config.redditClientSecret) {
    try {
      token = await ensureRedditToken(data);
    } catch (error) {
      return { byId: {}, warning: error.message };
    }
  }
  const requestUrl = token
    ? `${REDDIT_OAUTH_API_BASE}/by_id/${names}?raw_json=1`
    : `https://www.reddit.com/by_id/${names}.json?raw_json=1`;
  const headers = { "User-Agent": REDDIT_USER_AGENT, Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(requestUrl, { headers });
    if (!response.ok) {
      return {
        byId: {},
        warning: token
          ? `Reddit API 응답 ${response.status}`
          : `Reddit 응답 ${response.status} — Reddit 연동 설정에 앱 인증을 등록하면 자동 수집이 동작합니다`,
      };
    }
    const body = await response.json().catch(() => null);
    const children = body?.data?.children || [];
    const byId = {};
    for (const child of children) {
      const d = child.data || {};
      if (!d.id) continue;
      byId[d.id] = {
        title: d.title || "",
        subreddit: d.subreddit ? `r/${d.subreddit}` : "",
        upvotes: toNumber(d.score),
        comments: toNumber(d.num_comments),
        upvoteRatio: Number(d.upvote_ratio || 0),
        author: d.author || "",
        flair: d.link_flair_text || "",
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : "",
        createdUtc: d.created_utc || 0,
        removed: Boolean(d.removed_by_category) || Boolean(d.removed),
      };
    }
    return { byId, warning: "" };
  } catch (error) {
    return { byId: {}, warning: `Reddit 호출 실패: ${error.message}` };
  }
}

function applyRedditStats(post, stats) {
  if (!stats) return post;
  post.upvotes = stats.upvotes;
  post.comments = stats.comments;
  post.upvoteRatio = stats.upvoteRatio;
  if (!post.title && stats.title) post.title = stats.title;
  if (!post.subreddit && stats.subreddit) post.subreddit = stats.subreddit;
  if (!post.author && stats.author) post.author = stats.author;
  if (!post.flair && stats.flair) post.flair = stats.flair;
  if (!post.permalink && stats.permalink) post.permalink = stats.permalink;
  if (stats.removed) post.status = "removed";
  post.lastFetchedAt = nowIso();
  return post;
}

function normalizeRedditPost(post) {
  post.id ||= makeId("reddit", post.title || post.postId || "post");
  post.gameId ||= "";
  post.url ||= "";
  post.postId ||= parseRedditPostId(post.url);
  post.subreddit ||= "";
  post.title ||= "";
  post.permalink ||= "";
  post.author ||= "";
  post.flair ||= "";
  post.status = ["draft", "posted", "removed"].includes(post.status) ? post.status : "posted";
  post.postedAt ||= "";
  post.upvotes = toNumber(post.upvotes);
  post.comments = toNumber(post.comments);
  post.upvoteRatio = Number(post.upvoteRatio || 0);
  post.notes ||= "";
  post.lastFetchedAt ||= "";
  post.createdAt ||= nowIso();
  post.updatedAt ||= post.createdAt;
  return post;
}

function safeExportData(data, type = "all") {
  const common = {
    exportedAt: nowIso(),
    type,
    portfolioName: data.meta.portfolioName,
  };
  const collections = {
    games: data.games,
    storeListings: data.storeListings.map((listing) => sanitizeStoreListing(data, listing)),
    campaigns: data.campaigns,
    creatorProfiles: data.creatorProfiles,
    creators: data.creators,
    keys: data.influencerKeys.map(sanitizeKey),
    metrics: data.steamDailyMetrics,
    outreachLogs: data.outreachLogs,
    syncSchedule: data.syncSchedule,
    syncRuns: data.syncRuns,
  };
  if (type === "all") return { ...common, ...collections };
  if (type === "creators") return { ...common, creatorProfiles: collections.creatorProfiles, creators: collections.creators };
  if (type === "campaigns") return { ...common, campaigns: collections.campaigns };
  if (type === "keys") return { ...common, keys: collections.keys };
  if (type === "metrics") return { ...common, metrics: collections.metrics };
  if (type === "games") return { ...common, games: collections.games, storeListings: collections.storeListings };
  if (type === "outreach") return { ...common, outreachLogs: collections.outreachLogs };
  return { ...common, ...collections };
}

function scheduleNextRunAt(schedule, from = new Date()) {
  const base = schedule.lastRunAt ? new Date(schedule.lastRunAt) : from;
  if (Number.isNaN(base.getTime())) return from.toISOString();
  const next = new Date(base.getTime() + toNumber(schedule.intervalHours, 24) * 60 * 60 * 1000);
  return next.toISOString();
}

function scheduleWindow(schedule) {
  const endDate = addDays(toDateString(new Date()), -toNumber(schedule.startOffsetDays, 1));
  const startDate = addDays(endDate, -(toNumber(schedule.lookbackDays, 1) - 1));
  return { startDate, endDate };
}

function buildSyncScheduleStatus(data) {
  const schedule = data.syncSchedule;
  const nextRunAt = schedule.enabled ? schedule.nextRunAt || scheduleNextRunAt(schedule) : "";
  return {
    ...schedule,
    nextRunAt,
    due: Boolean(schedule.enabled && nextRunAt && new Date(nextRunAt).getTime() <= Date.now()),
    email: buildEmailStatus(data),
  };
}

function updateSyncSchedule(data, input = {}) {
  const current = data.syncSchedule;
  current.enabled = Boolean(input.enabled === true || input.enabled === "true" || input.enabled === "on");
  current.intervalHours = Math.max(1, Math.min(168, toNumber(input.intervalHours, current.intervalHours || 24)));
  current.gameId = input.gameId || current.gameId || "all";
  current.includeWishlist = input.includeWishlist !== false && input.includeWishlist !== "false";
  current.includeSales = input.includeSales === true || input.includeSales === "true" || input.includeSales === "on";
  current.includeViewGrants = input.includeViewGrants === true || input.includeViewGrants === "true" || input.includeViewGrants === "on";
  current.lookbackDays = Math.max(1, Math.min(14, toNumber(input.lookbackDays, current.lookbackDays || DEFAULT_SYNC_LOOKBACK_DAYS)));
  current.startOffsetDays = Math.max(0, Math.min(30, toNumber(input.startOffsetDays, current.startOffsetDays || 1)));
  current.nextRunAt = input.nextRunAt || (current.enabled ? scheduleNextRunAt(current, new Date()) : "");
  return current;
}

async function runScheduledSync(data, { force = false } = {}) {
  const schedule = data.syncSchedule;
  const status = buildSyncScheduleStatus(data);
  if (!schedule.enabled && !force) {
    return { skipped: true, reason: "schedule_disabled", schedule: status };
  }
  if (!force && !status.due) {
    return { skipped: true, reason: "not_due", schedule: status };
  }
  const window = scheduleWindow(schedule);
  const run = await runSteamSync(data, {
    gameId: schedule.gameId || "all",
    startDate: window.startDate,
    endDate: window.endDate,
    includeWishlist: schedule.includeWishlist,
    includeSales: schedule.includeSales,
    includeViewGrants: schedule.includeViewGrants,
    dryRun: false,
  });
  schedule.lastRunAt = run.finishedAt;
  schedule.lastRunId = run.id;
  schedule.lastStatus = run.status;
  schedule.lastMessage = run.warnings?.[0] || `${run.inserted} inserted, ${run.updated} updated`;
  schedule.nextRunAt = scheduleNextRunAt(schedule, new Date());
  return { skipped: false, run, schedule: buildSyncScheduleStatus(data) };
}

let schedulerRunning = false;

async function checkScheduledSync() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const data = await readData();
    const result = await runScheduledSync(data);
    if (!result.skipped) await writeData(data);
  } catch (error) {
    console.error("Scheduled sync check failed:", error.message || error);
  } finally {
    schedulerRunning = false;
  }
}

async function handleApi(req, res, url) {
  const data = await readData();
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/health") {
    return respondJson(res, 200, { ok: true, service: "launch-pilot-growth-dashboard", version: "0.1.0" });
  }

  if (route === "GET /api/meta") {
    return respondJson(res, 200, { ...data.meta, games: data.games, storeListings: data.storeListings.map((listing) => sanitizeStoreListing(data, listing)) });
  }

  if (route === "GET /api/games") {
    return respondJson(res, 200, buildPortfolio(data));
  }

  if (route === "POST /api/games") {
    const input = await readJson(req);
    if (!input.name || !String(input.name).trim()) return respondError(res, 400, "Game name is required.");
    const steamAppId = String(input.steamAppId || input.appId || "0");
    const game = {
      id: input.id || makeId("game", input.name),
      name: String(input.name).trim(),
      shortName: input.shortName || String(input.name).trim().slice(0, 2).toUpperCase(),
      steamAppId,
      stage: input.stage || "concept",
      genre: input.genre || "",
      launchDate: input.launchDate || "",
      owner: input.owner || "Growth",
      archived: Boolean(input.archived),
      status: Boolean(input.archived) ? "archived" : "active",
      imageUrl: sanitizeGameImage(input.imageUrl || ""),
      steamStoreUrl: input.steamStoreUrl || (steamAppId !== "0" ? steamStoreUrl(steamAppId, input.name) : ""),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.games.push(game);
    upsertSteamListingFromGame(data, game);
    await writeData(data);
    return respondJson(res, 201, { ...game, storeListings: storeListingsForGame(data, game.id, { includeArchived: true }).map((listing) => sanitizeStoreListing(data, listing)) });
  }

  const gameRoute = url.pathname.match(/^\/api\/games\/([^/]+)$/);
  if (gameRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const gameId = decodeURIComponent(gameRoute[1]);
    const game = data.games.find((item) => item.id === gameId);
    if (!game) return respondError(res, 404, "Game not found.");
    const input = await readJson(req);
    if (input.name !== undefined && !String(input.name).trim()) return respondError(res, 400, "Game name is required.");
    const nextName = input.name !== undefined ? String(input.name).trim() : game.name;
    const nextAppId = input.steamAppId !== undefined || input.appId !== undefined ? String(input.steamAppId || input.appId || "0") : game.steamAppId;
    game.name = nextName;
    game.shortName = input.shortName || game.shortName || nextName.slice(0, 2).toUpperCase();
    game.steamAppId = nextAppId;
    game.stage = input.stage || game.stage || "concept";
    game.genre = input.genre !== undefined ? input.genre : game.genre || "";
    game.launchDate = input.launchDate !== undefined ? input.launchDate : game.launchDate || "";
    game.owner = input.owner !== undefined ? input.owner : game.owner || "Growth";
    game.steamStoreUrl = input.steamStoreUrl || game.steamStoreUrl || (nextAppId !== "0" ? steamStoreUrl(nextAppId, nextName) : "");
    if (input.archived !== undefined || input.status !== undefined) {
      game.archived = input.archived === true || input.archived === "true" || input.status === "archived";
      game.status = game.archived ? "archived" : "active";
    }
    if (input.imageUrl !== undefined) game.imageUrl = sanitizeGameImage(input.imageUrl);
    game.updatedAt = nowIso();
    upsertSteamListingFromGame(data, game);
    await writeData(data);
    return respondJson(res, 200, { ...game, storeListings: storeListingsForGame(data, game.id, { includeArchived: true }).map((listing) => sanitizeStoreListing(data, listing)) });
  }

  if (gameRoute && req.method === "DELETE") {
    const gameId = decodeURIComponent(gameRoute[1]);
    const game = data.games.find((item) => item.id === gameId);
    if (!game) return respondError(res, 404, "Game not found.");
    // ?purge=true → permanent delete: remove the game and every record linked to it.
    if (url.searchParams.get("purge") === "true") {
      const keep = (item) => item.gameId !== gameId;
      const removed = {
        storeListings: data.storeListings.length,
        campaigns: data.campaigns.length,
        creators: data.creators.length,
        keys: data.influencerKeys.length,
        metrics: data.steamDailyMetrics.length,
      };
      data.games = data.games.filter((item) => item.id !== gameId);
      data.storeListings = data.storeListings.filter(keep);
      data.campaigns = data.campaigns.filter(keep);
      data.creators = data.creators.filter(keep);
      data.influencerKeys = data.influencerKeys.filter(keep);
      data.steamDailyMetrics = data.steamDailyMetrics.filter(keep);
      data.outreachLogs = data.outreachLogs.filter(keep);
      data.syncRuns = (data.syncRuns || []).filter((run) => run.gameId !== gameId);
      if (data.meta.primaryGameId === gameId) data.meta.primaryGameId = data.games[0]?.id || "";
      if (data.syncSchedule && data.syncSchedule.gameId === gameId) data.syncSchedule.gameId = "all";
      removed.storeListings -= data.storeListings.length;
      removed.campaigns -= data.campaigns.length;
      removed.creators -= data.creators.length;
      removed.keys -= data.influencerKeys.length;
      removed.metrics -= data.steamDailyMetrics.length;
      await writeData(data);
      return respondJson(res, 200, { ok: true, purged: true, id: gameId, removed });
    }
    game.archived = true;
    game.status = "archived";
    game.updatedAt = nowIso();
    for (const listing of storeListingsForGame(data, game.id, { includeArchived: true })) {
      listing.status = "archived";
      listing.updatedAt = nowIso();
    }
    await writeData(data);
    return respondJson(res, 200, { ...game, storeListings: storeListingsForGame(data, game.id, { includeArchived: true }).map((listing) => sanitizeStoreListing(data, listing)) });
  }

  if (route === "GET /api/store-listings") {
    const gameId = requestedGameId(url);
    const platform = url.searchParams.get("platform");
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const listings = scopedItems(data.storeListings, gameId)
      .filter((listing) => includeArchived || listing.status !== "archived")
      .filter((listing) => !platform || listing.platform === normalizeStorePlatform(platform))
      .map((listing) => sanitizeStoreListing(data, listing))
      .sort((a, b) => a.gameName.localeCompare(b.gameName) || a.platformLabel.localeCompare(b.platformLabel));
    return respondJson(res, 200, listings);
  }

  if (route === "POST /api/store-listings") {
    const input = await readJson(req);
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    const gameError = requireGame(data, gameId);
    if (gameError) return respondError(res, 400, gameError);
    const platform = normalizeStorePlatform(input.platform || "steam");
    let listing = data.storeListings.find((item) => item.gameId === gameId && item.platform === platform);
    const isNew = !listing;
    if (!listing) {
      listing = {
        id: input.id || makeId("listing", `${gameId}_${platform}`),
        gameId,
        platform,
        createdAt: nowIso(),
      };
      data.storeListings.push(listing);
    }
    updateStoreListingFromInput(data, listing, { ...input, gameId, platform });
    await writeData(data);
    return respondJson(res, isNew ? 201 : 200, sanitizeStoreListing(data, listing));
  }

  const storeListingRoute = url.pathname.match(/^\/api\/store-listings\/([^/]+)$/);
  if (storeListingRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const listingId = decodeURIComponent(storeListingRoute[1]);
    const listing = data.storeListings.find((item) => item.id === listingId);
    if (!listing) return respondError(res, 404, "Store listing not found.");
    const input = await readJson(req);
    if (input.gameId !== undefined) {
      const gameError = requireGame(data, String(input.gameId));
      if (gameError) return respondError(res, 400, gameError);
    }
    updateStoreListingFromInput(data, listing, input);
    await writeData(data);
    return respondJson(res, 200, sanitizeStoreListing(data, listing));
  }

  if (storeListingRoute && req.method === "DELETE") {
    const listingId = decodeURIComponent(storeListingRoute[1]);
    const listing = data.storeListings.find((item) => item.id === listingId);
    if (!listing) return respondError(res, 404, "Store listing not found.");
    listing.status = "archived";
    listing.updatedAt = nowIso();
    // The Steam listing mirrors the game's Steam App ID — clear it so the deleted listing
    // is not auto-recreated from the game's Steam signal on the next sync.
    if (normalizeStorePlatform(listing.platform) === "steam") {
      const game = data.games.find((item) => item.id === listing.gameId);
      if (game) {
        game.steamAppId = "0";
        game.steamStoreUrl = "";
        game.updatedAt = nowIso();
      }
    }
    await writeData(data);
    return respondJson(res, 200, sanitizeStoreListing(data, listing));
  }

  if (route === "GET /api/dashboard") {
    return respondJson(res, 200, buildDashboard(data, requestedGameId(url)));
  }

  if (route === "GET /api/readiness") {
    return respondJson(res, 200, buildReadiness(data));
  }

  if (route === "GET /api/youtube") {
    const config = effectiveIntegrationConfig(data);
    return respondJson(res, 200, {
      configured: Boolean(config.youtubeApiKey),
      keySource: config.youtubeKeySource,
      keyMasked: config.youtubeKeyMasked,
      oauth: {
        clientConfigured: Boolean(config.youtubeClientId && config.youtubeClientSecret),
        connected: config.youtubeOAuthConnected,
        connectedAt: data.integrationSettings.youtubeOAuthConnectedAt || "",
        clientId: config.youtubeClientId,
        redirectUri: youtubeOAuthRedirectUri(url),
      },
      channels: data.youtubeChannels,
      snapshots: data.youtubeSnapshots,
    });
  }

  if (route === "GET /api/youtube/oauth/start") {
    const config = effectiveIntegrationConfig(data);
    if (!config.youtubeClientId || !config.youtubeClientSecret) {
      return respondError(res, 400, "OAuth Client ID / Secret을 먼저 저장하세요.");
    }
    const state = randomBytes(16).toString("hex");
    data.integrationSettings.youtubeOAuthState = state;
    await writeData(data);
    res.writeHead(302, { Location: buildGoogleAuthUrl(config.youtubeClientId, youtubeOAuthRedirectUri(url), state) });
    return res.end();
  }

  if (route === "GET /api/youtube/oauth/callback") {
    const settings = data.integrationSettings;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errParam = url.searchParams.get("error");
    if (errParam) {
      res.writeHead(302, { Location: `/?ytauth=error&msg=${encodeURIComponent(errParam)}#youtube` });
      return res.end();
    }
    if (!code || !state || state !== settings.youtubeOAuthState) {
      res.writeHead(302, { Location: "/?ytauth=error&msg=invalid_state#youtube" });
      return res.end();
    }
    settings.youtubeOAuthState = "";
    try {
      const config = effectiveIntegrationConfig(data);
      const tokens = await googleTokenRequest({
        code,
        client_id: config.youtubeClientId,
        client_secret: config.youtubeClientSecret,
        redirect_uri: youtubeOAuthRedirectUri(url),
        grant_type: "authorization_code",
      });
      if (tokens.refresh_token) settings.youtubeRefreshTokenEncrypted = encryptSecret(tokens.refresh_token);
      settings.youtubeAccessToken = tokens.access_token || "";
      settings.youtubeAccessTokenExpiry = Date.now() + toNumber(tokens.expires_in, 3600) * 1000;
      settings.youtubeOAuthConnectedAt = nowIso();
      await writeData(data);
      res.writeHead(302, { Location: "/?ytauth=ok#youtube" });
      return res.end();
    } catch (error) {
      res.writeHead(302, { Location: `/?ytauth=error&msg=${encodeURIComponent(error.message)}#youtube` });
      return res.end();
    }
  }

  if (route === "POST /api/youtube/oauth/disconnect") {
    const settings = data.integrationSettings;
    settings.youtubeRefreshTokenEncrypted = "";
    settings.youtubeAccessToken = "";
    settings.youtubeAccessTokenExpiry = 0;
    settings.youtubeOAuthConnectedAt = "";
    settings.youtubeOAuthState = "";
    await writeData(data);
    return respondJson(res, 200, { ok: true });
  }

  if (route === "GET /api/youtube/analytics") {
    const config = effectiveIntegrationConfig(data);
    if (!config.youtubeOAuthConnected) return respondError(res, 400, "Google 계정을 먼저 연결하세요.");
    const channelId = url.searchParams.get("channelId");
    const channel =
      data.youtubeChannels.find((item) => item.id === channelId || item.channelId === channelId) || data.youtubeChannels[0];
    if (!channel) return respondError(res, 400, "분석할 채널이 없습니다. 채널을 먼저 추가하세요.");
    let analytics;
    try {
      analytics = await buildYoutubeAnalytics(data, channel.channelId, toNumber(url.searchParams.get("days"), 28));
    } catch (error) {
      return respondError(res, 400, error.message);
    }
    await writeData(data);
    return respondJson(res, 200, { channelId: channel.id, channelTitle: channel.title, ...analytics });
  }

  if (route === "GET /api/reddit-posts") {
    const gameId = requestedGameId(url);
    const posts = scopedItems(data.redditPosts, gameId)
      .map((post) => ({ ...post, gameName: post.gameId ? gameNameFor(data, post.gameId) : "" }))
      .sort((a, b) => String(b.postedAt || b.createdAt).localeCompare(String(a.postedAt || a.createdAt)));
    return respondJson(res, 200, posts);
  }

  if (route === "POST /api/reddit-posts") {
    const input = await readJson(req);
    if (input.gameId) {
      const gameError = requireGame(data, String(input.gameId));
      if (gameError) return respondError(res, 400, gameError);
    }
    const postUrl = String(input.url || "").trim();
    const postId = parseRedditPostId(postUrl || input.postId || "");
    const post = normalizeRedditPost({
      gameId: input.gameId || "",
      url: postUrl,
      postId,
      subreddit: input.subreddit || "",
      title: input.title || "",
      status: input.status || "posted",
      postedAt: input.postedAt || "",
      notes: input.notes || "",
    });
    if (postId) {
      const { byId } = await redditFetchByIds(data, [postId]);
      const stats = byId[postId];
      if (stats) {
        applyRedditStats(post, stats);
        if (!post.postedAt && stats.createdUtc) post.postedAt = toDateString(new Date(stats.createdUtc * 1000));
        if (!post.url && stats.permalink) post.url = stats.permalink;
      }
    }
    data.redditPosts.push(post);
    await writeData(data);
    return respondJson(res, 201, post);
  }

  if (route === "POST /api/reddit-posts/refresh") {
    const targets = data.redditPosts.filter((post) => post.postId);
    if (!targets.length) return respondJson(res, 200, { updated: 0, total: 0, warning: "갱신할 글이 없습니다." });
    const { byId, warning } = await redditFetchByIds(data, targets.map((post) => post.postId));
    let updated = 0;
    for (const post of targets) {
      if (byId[post.postId]) {
        applyRedditStats(post, byId[post.postId]);
        post.updatedAt = nowIso();
        updated += 1;
      }
    }
    await writeData(data);
    return respondJson(res, 200, { updated, total: targets.length, warning });
  }

  const redditPostRoute = url.pathname.match(/^\/api\/reddit-posts\/([^/]+)$/);
  if (redditPostRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const id = decodeURIComponent(redditPostRoute[1]);
    const post = data.redditPosts.find((item) => item.id === id);
    if (!post) return respondError(res, 404, "글을 찾지 못했습니다.");
    const input = await readJson(req);
    if (input.gameId !== undefined) {
      if (input.gameId) {
        const gameError = requireGame(data, String(input.gameId));
        if (gameError) return respondError(res, 400, gameError);
      }
      post.gameId = String(input.gameId || "");
    }
    if (input.url !== undefined) {
      post.url = String(input.url).trim();
      post.postId = parseRedditPostId(post.url) || post.postId;
    }
    if (input.subreddit !== undefined) post.subreddit = String(input.subreddit).trim();
    if (input.title !== undefined) post.title = String(input.title).trim();
    if (input.status !== undefined && ["draft", "posted", "removed"].includes(input.status)) post.status = input.status;
    if (input.postedAt !== undefined) post.postedAt = input.postedAt || "";
    if (input.notes !== undefined) post.notes = String(input.notes);
    if (input.upvotes !== undefined) post.upvotes = toNumber(input.upvotes);
    if (input.comments !== undefined) post.comments = toNumber(input.comments);
    post.updatedAt = nowIso();
    await writeData(data);
    return respondJson(res, 200, post);
  }

  if (redditPostRoute && req.method === "DELETE") {
    const id = decodeURIComponent(redditPostRoute[1]);
    const before = data.redditPosts.length;
    data.redditPosts = data.redditPosts.filter((item) => item.id !== id);
    if (data.redditPosts.length === before) return respondError(res, 404, "글을 찾지 못했습니다.");
    await writeData(data);
    return respondJson(res, 200, { ok: true, id });
  }

  if (route === "POST /api/youtube/channels") {
    const input = await readJson(req);
    const config = effectiveIntegrationConfig(data);
    if (!config.youtubeApiKey) return respondError(res, 400, "YouTube API Key를 먼저 저장하세요.");
    const ref = parseChannelRef(input.channelId || input.url || input.handle);
    if (!ref) return respondError(res, 400, "채널 ID 또는 핸들(@name)을 입력하세요.");
    let item;
    try {
      item = await fetchYoutubeChannel(config.youtubeApiKey, ref);
    } catch (error) {
      return respondError(res, 400, error.message);
    }
    const existing = data.youtubeChannels.find((channel) => channel.channelId === item.id);
    const channel =
      existing || { id: makeId("yt", item.snippet?.title || item.id), channelId: item.id, createdAt: nowIso(), recentVideos: [] };
    applyYoutubeChannelStats(channel, item);
    channel.lastSyncedAt = nowIso();
    if (!existing) data.youtubeChannels.push(channel);
    try {
      channel.recentVideos = await fetchYoutubeRecentVideos(config.youtubeApiKey, channel.uploadsPlaylistId);
    } catch {
      /* keep stats even if recent videos fail */
    }
    upsertYoutubeSnapshot(data, channel, toDateString(new Date()));
    await writeData(data);
    return respondJson(res, existing ? 200 : 201, channel);
  }

  const youtubeChannelRoute = url.pathname.match(/^\/api\/youtube\/channels\/([^/]+)$/);
  if (youtubeChannelRoute && req.method === "DELETE") {
    const id = decodeURIComponent(youtubeChannelRoute[1]);
    const channel = data.youtubeChannels.find((item) => item.id === id || item.channelId === id);
    if (!channel) return respondError(res, 404, "채널을 찾지 못했습니다.");
    data.youtubeChannels = data.youtubeChannels.filter((item) => item !== channel);
    data.youtubeSnapshots = data.youtubeSnapshots.filter((item) => item.channelId !== channel.channelId);
    await writeData(data);
    return respondJson(res, 200, { ok: true, id });
  }

  if (route === "POST /api/youtube/sync") {
    const input = await readJson(req);
    const config = effectiveIntegrationConfig(data);
    if (!config.youtubeApiKey) return respondError(res, 400, "YouTube API Key를 먼저 저장하세요.");
    let result;
    try {
      result = await syncYoutubeChannels(data, input.channelId || "all");
    } catch (error) {
      return respondError(res, 400, error.message);
    }
    await writeData(data);
    return respondJson(res, 200, { ...result, channels: data.youtubeChannels, snapshots: data.youtubeSnapshots });
  }

  if (route === "GET /api/settings") {
    return respondJson(res, 200, publicSettings(data));
  }

  if (route === "PUT /api/settings") {
    const input = await readJson(req);
    const settings = updateIntegrationSettings(data, input);
    await writeData(data);
    return respondJson(res, 200, settings);
  }

  if (route === "GET /api/campaigns") {
    return respondJson(res, 200, campaignsWithMetrics(data, requestedGameId(url)));
  }

  if (route === "POST /api/campaigns") {
    const input = await readJson(req);
    const validationError = validateCampaign(input);
    if (validationError) return respondError(res, 400, validationError);
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    const gameError = requireGame(data, gameId);
    if (gameError) return respondError(res, 400, gameError);
    const campaign = {
      id: input.id || makeId("campaign", input.name),
      gameId,
      name: String(input.name).trim(),
      startDate: input.startDate || new Date().toISOString().slice(0, 10),
      endDate: input.endDate || "",
      channels: toList(input.channels),
      goal: input.goal || "",
      sentEmails: toNumber(input.sentEmails),
      replies: toNumber(input.replies),
      keysSent: toNumber(input.keysSent),
      videosUploaded: toNumber(input.videosUploaded),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.campaigns.push(campaign);
    await writeData(data);
    return respondJson(res, 201, campaign);
  }

  if (route === "GET /api/creator-profiles") {
    return respondJson(res, 200, creatorProfilesWithStats(data));
  }

  if (route === "POST /api/creator-profiles") {
    const input = await readJson(req);
    const validationError = validateCreator(input);
    if (validationError) return respondError(res, 400, validationError);
    const profile = upsertCreatorProfile(data, input);
    await writeData(data);
    return respondJson(res, 201, { ...profile, stats: creatorProfileStats(data, profile) });
  }

  if (route === "POST /api/import/creator-csv/preview") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    let preview;
    try {
      preview = previewCreatorCsv(data, input.csvText);
    } catch (error) {
      return respondError(res, 400, error.message || "Creator CSV preview failed.");
    }
    return respondJson(res, 200, preview);
  }

  if (route === "POST /api/import/creator-csv") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    let result;
    try {
      result = importCreatorCsv(data, input.csvText);
    } catch (error) {
      return respondError(res, 400, error.message || "Creator CSV import failed.");
    }
    await writeData(data);
    return respondJson(res, 201, { ...result, creatorProfiles: creatorProfilesWithStats(data) });
  }

  if (route === "GET /api/creators") {
    const gameId = requestedGameId(url);
    return respondJson(
      res,
      200,
      scopedItems(data.creators, gameId)
        .map((creator) => ({
          ...creator,
          gameName: gameNameFor(data, creator.gameId),
          campaignName: campaignNameFor(data, creator.campaignId, "", creator.gameId),
        }))
        .sort((a, b) => toNumber(b.fitScore) - toNumber(a.fitScore)),
    );
  }

  if (route === "POST /api/creators") {
    const input = await readJson(req);
    const validationError = validateCreator(input);
    if (validationError) return respondError(res, 400, validationError);
    const channelName = String(input.channelName || input.name).trim();
    const platform = input.platform || "YouTube";
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    const gameError = requireGame(data, gameId);
    if (gameError) return respondError(res, 400, gameError);
    const campaignId = input.campaignId || "";
    const creatorSlug = String(input.handle || channelName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const profile = upsertCreatorProfile(data, {
      ...input,
      channelName,
      platform,
      handle: input.handle || creatorSlug,
    });
    const creator = {
      id: input.id || makeId("creator", channelName),
      creatorProfileId: profile.id,
      gameId,
      channelName: profile.channelName || channelName,
      handle: input.handle || profile.handle || creatorSlug,
      platform,
      email: input.email || profile.email || "",
      country: input.country || profile.country || "",
      tags: toList(input.tags || input.niche || profile.tags),
      subscribers: toNumber(input.subscribers || input.followers || profile.subscribers),
      averageViews: toNumber(input.averageViews || profile.averageViews),
      fitScore: Math.max(0, Math.min(100, toNumber(input.fitScore || profile.fitScore))),
      status: STATUS_OPTIONS.has(input.status) ? input.status : "uncontacted",
      campaignId,
      utmLink:
        input.utmLink ||
        (campaignId
          ? buildUtmLink(data, {
              source: String(platform).toLowerCase(),
              medium: "influencer",
              gameId,
              campaignId,
              content: creatorSlug,
            })
          : ""),
      note: input.note || "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.creators.push(creator);
    await writeData(data);
    return respondJson(res, 201, creator);
  }

  if (route === "POST /api/email-drafts") {
    const input = await readJson(req);
    let draft;
    try {
      draft = buildEmailDraft(data, input);
    } catch (error) {
      return respondError(res, 400, error.message || "Email draft failed.");
    }
    return respondJson(res, 201, draft);
  }

  if (route === "GET /api/email/status") {
    return respondJson(res, 200, buildEmailStatus(data));
  }

  if (route === "POST /api/email-send") {
    const input = await readJson(req);
    const result = await sendOutreachEmail(data, input);
    await writeData(data);
    return respondJson(res, 200, result);
  }

  if (route === "GET /api/outreach-logs") {
    const gameId = requestedGameId(url);
    return respondJson(
      res,
      200,
      scopedItems(data.outreachLogs, gameId).map((log) => ({
        ...log,
        gameName: log.gameId ? gameNameFor(data, log.gameId) : "",
        creatorName:
          data.creators.find((creator) => creator.id === log.creatorId)?.channelName ||
          data.creatorProfiles.find((profile) => profile.id === log.creatorProfileId)?.channelName ||
          "",
        campaignName: campaignNameFor(data, log.campaignId, "", log.gameId),
      })),
    );
  }

  if (route === "GET /api/keys") {
    const gameId = requestedGameId(url);
    return respondJson(
      res,
      200,
      scopedItems(data.influencerKeys, gameId).map((key) => ({
        ...sanitizeKey(key),
        gameName: gameNameFor(data, key.gameId),
        campaignName: campaignNameFor(data, key.campaignId, "", key.gameId),
      })),
    );
  }

  if (route === "POST /api/keys") {
    const input = await readJson(req);
    const validationError = validateKey(input);
    if (validationError) return respondError(res, 400, validationError);
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    const gameError = requireGame(data, gameId);
    if (gameError) return respondError(res, 400, gameError);
    const rawSteamKey = input.steamKey || input.key || input.code || input.value || "";
    const recipientName =
      input.recipientName ||
      input.creatorHandle ||
      input.recipientEmail ||
      (input.creatorId ? data.creators.find((item) => item.id === input.creatorId && item.gameId === gameId)?.channelName : "") ||
      "Unassigned recipient";
    const campaignId =
      input.campaignId ||
      (input.campaignName ? data.campaigns.find((campaign) => campaign.name === input.campaignName && campaign.gameId === gameId)?.id : "") ||
      "";
    const key = {
      id: input.id || makeId("key", recipientName),
      gameId,
      recipientName: String(recipientName).trim(),
      recipientEmail: input.recipientEmail || "",
      creatorId: input.creatorId || "",
      campaignId,
      status: KEY_STATUS_OPTIONS.has(input.status) ? input.status : input.status === "available" ? "reserved" : "reserved",
      steamKeyEncrypted: rawSteamKey ? encryptSteamKey(rawSteamKey) : "",
      steamKeyMasked: rawSteamKey ? maskSteamKey(rawSteamKey) : input.steamKeyMasked || "",
      utmLink: input.utmLink || "",
      note: input.note || input.notes || "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.influencerKeys.push(key);

    if (key.campaignId) {
      const campaign = data.campaigns.find((item) => item.id === key.campaignId && item.gameId === key.gameId);
      if (campaign && ["sent", "claimed", "video_uploaded"].includes(key.status)) {
        campaign.keysSent = toNumber(campaign.keysSent) + 1;
        campaign.updatedAt = nowIso();
      }
    }

    if (key.creatorId && ["sent", "claimed", "video_uploaded"].includes(key.status)) {
      const creator = data.creators.find((item) => item.id === key.creatorId && item.gameId === key.gameId);
      if (creator && creator.status !== "video_uploaded") {
        creator.status = "key_sent";
        creator.updatedAt = nowIso();
      }
    }

    await writeData(data);
    return respondJson(res, 201, sanitizeKey(key));
  }

  if (route === "GET /api/steam-metrics") {
    const gameId = requestedGameId(url);
    return respondJson(
      res,
      200,
      scopedItems(data.steamDailyMetrics, gameId)
        .map((metric) => ({
          ...metric,
          gameName: gameNameFor(data, metric.gameId),
          campaignName: campaignNameFor(data, metric.campaignId, metric.campaignName, metric.gameId),
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    );
  }

  if (route === "POST /api/utm-links") {
    const input = await readJson(req);
    if (!input.baseUrl) {
      const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
      const gameError = requireGame(data, gameId);
      if (gameError) return respondError(res, 400, gameError);
      input.gameId = gameId;
    }
    const link = buildUtmLink(data, input);
    if (input.creatorId) {
      const creator = data.creators.find((item) => item.id === input.creatorId && (!input.gameId || item.gameId === input.gameId));
      if (creator) {
        creator.utmLink = link;
        creator.updatedAt = nowIso();
        await writeData(data);
      }
    }
    return respondJson(res, 201, { link });
  }

  if (route === "GET /api/steam-sync/status") {
    return respondJson(res, 200, buildSteamSyncStatus(data));
  }

  if (route === "GET /api/sync-schedule") {
    return respondJson(res, 200, buildSyncScheduleStatus(data));
  }

  if (route === "PUT /api/sync-schedule") {
    const input = await readJson(req);
    updateSyncSchedule(data, input);
    await writeData(data);
    return respondJson(res, 200, buildSyncScheduleStatus(data));
  }

  if (route === "POST /api/sync-schedule/run-due") {
    const input = await readJson(req);
    const result = await runScheduledSync(data, { force: Boolean(input.force) });
    await writeData(data);
    return respondJson(res, 200, result);
  }

  const syncRunRoute = url.pathname.match(/^\/api\/steam-sync\/runs\/([^/]+)$/);
  if (syncRunRoute && req.method === "GET") {
    const runId = decodeURIComponent(syncRunRoute[1]);
    const run = data.syncRuns.find((item) => item.id === runId);
    if (!run) return respondError(res, 404, "Sync run not found.");
    return respondJson(res, 200, run);
  }

  if (route === "POST /api/steam-sync/run") {
    const input = await readJson(req);
    const run = await runSteamSync(data, input);
    await writeData(data);
    return respondJson(res, 201, { run, status: buildSteamSyncStatus(data), dashboard: buildDashboard(data, input.gameId || "all") });
  }

  if (route === "POST /api/import/steam-csv/preview") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    let preview;
    try {
      preview = previewSteamCsv(data, input.csvText, resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID));
    } catch (error) {
      return respondError(res, 400, error.message || "CSV preview failed.");
    }
    return respondJson(res, 200, preview);
  }

  if (route === "POST /api/import/steam-csv") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    let result;
    try {
      result = importSteamCsv(data, input.csvText, resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID));
    } catch (error) {
      return respondError(res, 400, error.message || "CSV import failed.");
    }
    await writeData(data);
    return respondJson(res, 201, { ...result, dashboard: buildDashboard(data, input.gameId || "all") });
  }

  if (route === "GET /api/export") {
    const type = url.searchParams.get("type") || "all";
    return respondJson(res, 200, safeExportData(data, type));
  }

  return respondError(res, 404, "API route not found.");
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return respondError(res, 405, "Method not allowed.");
  }

  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return respondError(res, 403, "Forbidden.");
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file.");
    const body = await readFile(filePath);
    const contentType = contentTypes.get(path.extname(filePath)) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  } catch {
    return respondError(res, 404, "File not found.");
  }
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid JSON body." : error.message || "Unexpected server error.";
    const statusCode = error instanceof SyntaxError ? 400 : error.statusCode || 500;
    return respondError(res, statusCode, message);
  }
}

ensureDb();

createServer(handleRequest).listen(PORT, HOST, () => {
  console.log(`Launch Pilot Growth Dashboard running at http://${HOST}:${PORT}`);
});

if (!DISABLE_SYNC_SCHEDULER) {
  setInterval(checkScheduledSync, Math.max(10_000, SYNC_SCHEDULER_INTERVAL_MS));
}
