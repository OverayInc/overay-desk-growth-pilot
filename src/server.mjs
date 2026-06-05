import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, loadData, persistData, migrateFromJson } from "./db.mjs";
import {
  authEnabled,
  getPublicAuthConfig,
  authConfigSummary,
  authenticateRequest,
  AuthError,
} from "./auth.mjs";
import { generateEmailTemplate, translateText, aiConfig } from "./marketingAgent.mjs";
import { runDiscovery } from "./discovery/pipeline.mjs";
import { expandSeeds } from "./marketingAgent.mjs";
import { makeRenderer, closeRenderer } from "./discovery/renderer.mjs";
import {
  discoverySeeds,
  discoveryGameContext,
  discoveryWindow,
  inWindow,
  discoveryUseRenderer,
  clampSessionMinutes,
} from "./discovery/config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
// Content hash of the versioned front-end assets, computed once at startup and
// injected into index.html (replaces __ASSET_VERSION__). Changes automatically
// whenever the code changes, so each deploy busts browser/CDN caches with no
// manual version bump.
const ASSET_VERSION = (() => {
  try {
    const hash = createHash("sha256");
    for (const name of ["app.js", "styles.css", "auth.js"]) {
      const file = path.join(PUBLIC_DIR, name);
      if (existsSync(file)) hash.update(readFileSync(file));
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
})();
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
// Microsoft Graph app-only (client credentials) mail sending. Falls back to the
// login app's tenant/client when a dedicated Graph app isn't configured.
const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || process.env.MS_TENANT_ID || "";
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID || "";
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || "";
const GRAPH_SEND_MAILBOX = process.env.GRAPH_SEND_MAILBOX || "";
const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const graphTokenUrl = (tenantId) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const DISABLE_SYNC_SCHEDULER = process.env.DISABLE_SYNC_SCHEDULER === "true";
const SYNC_SCHEDULER_INTERVAL_MS = Number(process.env.SYNC_SCHEDULER_INTERVAL_MS || 60_000);
// Creator-discovery bot. The nightly window scheduler is off by default (run
// manually via the dashboard first); enable with DISABLE_DISCOVERY_SCHEDULER=false.
const DISABLE_DISCOVERY_SCHEDULER = process.env.DISABLE_DISCOVERY_SCHEDULER !== "false";
const DISCOVERY_EXPAND_COUNT = Number(process.env.DISCOVERY_EXPAND_COUNT || 8);
const DISCOVERY_LEAD_DEPTH = Number(process.env.DISCOVERY_LEAD_DEPTH || 2);
const DISCOVERY_CHUNK_MS = Math.max(60_000, Number(process.env.DISCOVERY_CHUNK_MS || 300_000));
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const WEB_SEARCH_PROVIDER = process.env.WEB_SEARCH_PROVIDER || "";
const WEB_SEARCH_API_KEY = process.env.WEB_SEARCH_API_KEY || "";
const DEFAULT_SYNC_LOOKBACK_DAYS = Number(process.env.DEFAULT_SYNC_LOOKBACK_DAYS || 7);

// Simplified per-game creator status. Steam "used / unused" is tracked separately on
// steamActivation (querycdkey), not here. "리뷰"/"기타" detail goes in the note field.
const STATUS_OPTIONS = new Set(["uncontacted", "sent", "review", "other"]);

// 대상 구분 (Excel: 유튜버/스트리머/리뷰어/매체/큐레이터/기타). Stored canonical, displayed via labels on the client.
const KEY_RECIPIENT_TYPE_OPTIONS = new Set(["youtuber", "streamer", "reviewer", "press", "curator", "other"]);

// Maps the Korean labels used in the legacy spreadsheet tracker to the canonical values above.
const KEY_RECIPIENT_TYPE_ALIASES = {
  유튜버: "youtuber",
  유투버: "youtuber",
  youtube: "youtuber",
  youtuber: "youtuber",
  스트리머: "streamer",
  streamer: "streamer",
  twitch: "streamer",
  리뷰어: "reviewer",
  reviewer: "reviewer",
  매체: "press",
  언론: "press",
  press: "press",
  media: "press",
  큐레이터: "curator",
  curator: "curator",
  기타: "other",
  other: "other",
};

// Maps Korean labels, the spreadsheet vocabulary, and legacy canonical statuses to the
// simplified set (uncontacted / sent / review / other). Usage (사용됨/미사용) is NOT a status —
// it comes from the Steam activation query — so "사용됨" maps to "sent".
const CREATOR_STATUS_ALIASES = {
  미접촉: "uncontacted",
  uncontacted: "uncontacted",
  미발송: "uncontacted",
  예약: "uncontacted",
  키미발송: "uncontacted",
  reserved: "uncontacted",
  초안: "uncontacted",
  초안작성: "uncontacted",
  drafted: "uncontacted",
  발송: "sent",
  발송됨: "sent",
  키발송: "sent",
  메일발송: "sent",
  메일보냄: "sent",
  first_sent: "sent",
  회신: "sent",
  회신옴: "sent",
  답장: "sent",
  replied: "sent",
  미사용: "sent",
  사용됨: "sent",
  사용: "sent",
  claimed: "sent",
  key_sent: "sent",
  sent: "sent",
  리뷰: "review",
  리뷰완료: "review",
  review: "review",
  영상: "review",
  영상업로드: "review",
  video_uploaded: "review",
  기타: "other",
  other: "other",
  보류: "other",
  paused: "other",
  회수: "other",
  회수필요: "other",
  회수완료: "other",
  revoked: "other",
  반려: "other",
  무응답: "other",
  반려무응답: "other",
  bounced: "other",
};

function normalizeRecipientType(value) {
  // Normalize to NFC: Korean text can arrive decomposed (NFD) from some OSes / clients,
  // which would otherwise never match the precomposed alias-table keys.
  const raw = String(value || "").trim().normalize("NFC");
  if (!raw) return "youtuber";
  const lower = raw.toLowerCase();
  if (KEY_RECIPIENT_TYPE_OPTIONS.has(lower)) return lower;
  const compact = raw.replace(/[\s/]+/g, "").toLowerCase();
  return KEY_RECIPIENT_TYPE_ALIASES[raw] || KEY_RECIPIENT_TYPE_ALIASES[compact] || KEY_RECIPIENT_TYPE_ALIASES[lower] || "other";
}

function normalizeCreatorStatus(value, fallback = "uncontacted") {
  const raw = String(value || "").trim().normalize("NFC");
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (STATUS_OPTIONS.has(lower)) return lower;
  const compact = raw.replace(/[\s/·]+/g, "").toLowerCase();
  return CREATOR_STATUS_ALIASES[raw] || CREATOR_STATUS_ALIASES[compact] || CREATOR_STATUS_ALIASES[lower] || fallback;
}

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

// Built-in outreach email templates (EN + KO). Placeholders: {{creator}} {{game}}
// {{key}} {{utm}} {{embargo}} {{genre}}. Team signature is baked in.
function defaultEmailTemplates() {
  const t = (id, name, subjectEn, bodyEn, subjectKo, bodyKo) => ({
    id,
    name,
    subjectEn,
    bodyEn,
    subjectKo,
    bodyKo,
    builtin: true,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  });
  const sigEn = "— Immersed Player, Overay Inc.";
  const sigKo = "— 오버레이(Overay Inc.) · Immersed Player 팀";
  return [
    t(
      "tmpl_review_request",
      "기본 리뷰 요청",
      "{{game}} — a 'spot the anomaly' game your viewers can play along with",
      `Hi {{creator}},\n\nWe're Immersed Player at Overay Inc., the team behind {{game}}.\n\n{{game}} is an observation game: you read a space and catch the one thing that's subtly "off." On camera that's the hook — viewers lean in and hunt the anomaly with you in the comments and chat, so it tends to drive strong engagement.\n\nWe'd love to send you a free Steam key for an honest playthrough. To make it work for your audience we can also add:\n• Extra keys to give away to your viewers\n• An early / exclusive build before launch\n\nNo obligation at all — just reply and we'll send everything over.\n\n{{utm}}\n\nThanks for taking a look!\n${sigEn}`,
      "{{game}} — 시청자와 '이상현상 찾기'를 함께 즐기는 게임",
      `안녕하세요 {{creator}}님,\n\n저희는 {{game}}을(를) 만든 오버레이(Overay Inc.) Immersed Player 팀이에요.\n\n{{game}}은(는) '관찰' 게임이에요. 공간을 살피다가 미묘하게 '이상한 점' 하나를 찾아내죠. 이게 화면에서 특히 잘 통해요 — 시청자들이 댓글·채팅에서 같이 이상현상을 찾으며 몰입하거든요. 그래서 참여 반응이 좋은 편이에요.\n\n솔직한 플레이 영상용으로 무료 Steam 키를 보내드리고 싶어요. 채널에 더 도움이 되도록 이런 것도 함께 드릴 수 있어요:\n• 시청자에게 나눠줄 증정용 키\n• 출시 전 선공개 / 독점 빌드\n\n전혀 부담 갖지 않으셔도 돼요 — 회신만 주시면 전부 보내드릴게요.\n\n{{utm}}\n\n봐주셔서 감사합니다!\n${sigKo}`,
    ),
    t(
      "tmpl_short_casual",
      "짧고 캐주얼",
      "Quick one — a 'find the anomaly' game for {{creator}}?",
      `Hey {{creator}},\n\nBig fan of your channel. We made {{game}} — an observation game where viewers help you spot what's "off" in a space (great for comments/chat).\n\nWant a free Steam key? We can also throw in extra keys to give away to your audience, or an early build.\n\n{{utm}}\n\nJust say the word!\n${sigEn}`,
      "간단히 — {{creator}}님께 '이상현상 찾기' 게임",
      `안녕하세요 {{creator}}님!\n\n채널 잘 보고 있어요. 저희가 만든 {{game}}은(는) 공간 속 '이상한 점'을 시청자와 함께 찾는 관찰 게임이에요 (댓글·채팅 반응이 좋아요).\n\n무료 Steam 키 드릴까요? 원하시면 시청자 증정용 키나 선공개 빌드도 같이 챙겨드려요.\n\n{{utm}}\n\n편하게 한마디만 주세요!\n${sigKo}`,
    ),
    t(
      "tmpl_personalized",
      "채널 맞춤",
      "Loved [recent video] — {{game}} could land the same way",
      `Hi {{creator}},\n\nI caught your recent [mention a specific video] and the way your audience reacts in the comments is exactly what {{game}} is built for.\n\nIt's an observation game — players catch the one thing that's "off" in a space, and viewers love hunting it alongside you, which keeps the comments/chat busy.\n\nI'd be glad to send a Steam key, plus giveaway keys for your viewers (or an early build if the timing fits) — only if it feels right for your channel.\n\n{{utm}}\n\nHappy to answer anything.\n${sigEn}`,
      "[최근 영상] 잘 봤어요 — {{game}}도 비슷하게 통할 것 같아요",
      `안녕하세요 {{creator}}님,\n\n최근 [특정 영상 언급] 잘 봤는데, 댓글에서 시청자분들이 반응하시는 방식이 {{game}}이(가) 노리는 지점과 정확히 맞더라고요.\n\n{{game}}은(는) 공간 속 '이상한 점' 하나를 찾는 관찰 게임이라, 시청자가 함께 찾는 재미가 커서 댓글·채팅이 계속 살아 있어요.\n\nSteam 키와 시청자 증정용 키(타이밍 맞으면 선공개 빌드까지) 기꺼이 보내드릴게요 — 채널과 어울린다고 느끼실 때만요.\n\n{{utm}}\n\n궁금한 점 있으면 언제든요.\n${sigKo}`,
    ),
    t(
      "tmpl_horror",
      "이상현상·몰입형 (Exit 8 류)",
      "An immersive 'spot the anomaly' experience — {{game}}",
      `Hi {{creator}},\n\n{{game}} is a first-person observation experience: you read a space, and when something is subtly "off," you have to notice it. Tense and eerie, but easy to pick up — no twitch skills required.\n\nIt plays great on camera because the audience plays too: everyone's calling out the anomaly in chat and comments, so it drives real engagement (and very clippable misses).\n\nHappy to send a Steam key for a playthrough or first-impressions. We can also include keys to give away to your viewers, or an early / exclusive build.\n\n{{utm}}\n\n${sigEn}`,
      "몰입형 '이상현상 찾기' 경험 — {{game}}",
      `안녕하세요 {{creator}}님,\n\n{{game}}은(는) 1인칭 관찰 경험이에요. 공간을 읽다가 뭔가 미묘하게 '이상해지면' 그걸 알아채야 하죠. 오싹하고 긴장감 있지만 조작이 쉬워서 누구나 바로 즐길 수 있어요.\n\n화면에서 특히 잘 통하는 이유는 시청자도 함께 플레이하기 때문이에요 — 채팅·댓글에서 다 같이 이상현상을 외치니 참여 반응이 크고, 놓쳤을 때의 클립도 잘 나와요.\n\n플레이/첫인상 영상용 Steam 키 보내드릴게요. 시청자 증정용 키나 선공개·독점 빌드도 함께 가능해요.\n\n{{utm}}\n\n${sigKo}`,
    ),
    t(
      "tmpl_streamer",
      "스트리머(라이브)",
      "{{game}} streams great — your chat hunts the anomaly with you",
      `Hi {{creator}},\n\n{{game}} is made for live: it's an observation game where your chat spots the "off" detail with you — constant call-outs, instant reactions, clip-worthy misses.\n\nWe can send a Steam key for stream, plus extra keys to give away to your viewers live (always a chat-pleaser). Early / exclusive build available too. Embargo if any: {{embargo}}\n\n{{utm}}\n\n${sigEn}`,
      "{{game}}은 방송에 딱 — 채팅이 같이 이상현상을 찾아요",
      `안녕하세요 {{creator}}님,\n\n{{game}}은(는) 라이브에 잘 맞아요. 채팅이 같이 '이상한 점'을 찾는 관찰 게임이라 외침·즉각 반응·놓쳤을 때의 클립이 계속 나와요.\n\n방송용 Steam 키와 함께, 방송 중 시청자에게 나눠줄 증정용 키도 드릴 수 있어요(채팅 반응 최고). 선공개/독점 빌드도 가능합니다. 엠바고(있다면): {{embargo}}\n\n{{utm}}\n\n${sigKo}`,
    ),
    t(
      "tmpl_curator",
      "스팀 큐레이터",
      "Curator key — {{game}} (an observation / anomaly game)",
      `Hello {{creator}},\n\nWe'd love to offer your Steam Curator page a key for {{game}} from Immersed Player by Overay Inc. — an observation game about catching the one thing that's "off" in a space.\n\nIf it's a fit, a recommendation would mean a lot, and we're happy to share keys for your community too.\n\nStore page: {{utm}}\n\nReply and we'll add the key to your curator queue.\n\nThank you!\n${sigEn}`,
      "큐레이터 키 — {{game}} (관찰·이상현상 게임)",
      `안녕하세요 {{creator}}님,\n\n오버레이 Immersed Player 팀의 {{game}} 키를 큐레이터 페이지용으로 드리고 싶어요 — 공간 속 '이상한 점'을 찾는 관찰 게임이에요.\n\n잘 맞는다면 추천 한마디가 큰 힘이 되고, 커뮤니티용 키도 함께 나눠드릴 수 있어요.\n\n상점 페이지: {{utm}}\n\n회신 주시면 큐레이터 큐에 키를 추가해 드릴게요.\n\n감사합니다!\n${sigKo}`,
    ),
    t(
      "tmpl_press",
      "매체·프레스",
      "Press key & assets — {{game}} (observation / anomaly game)",
      `Hello,\n\nI'm writing from Immersed Player by Overay Inc. about {{game}} — a first-person observation game about spotting the anomaly in a space.\n\nHappy to provide a Steam press key plus a press kit (trailer, screenshots, fact sheet) for coverage. Review embargo (if any): {{embargo}}\nStore page: {{utm}}\n\nGlad to set up an interview or a hands-on build.\n${sigEn}`,
      "프레스 키 & 자료 — {{game}} (관찰·이상현상 게임)",
      `안녕하세요,\n\n오버레이 Immersed Player 팀에서 {{game}} 관련하여 연락드립니다 — 공간 속 이상현상을 찾는 1인칭 관찰 게임이에요.\n\n기사 검토용으로 Steam 프레스 키와 보도자료(트레일러·스크린샷·팩트시트)를 제공해 드릴 수 있어요. 리뷰 엠바고(있는 경우): {{embargo}}\n상점 페이지: {{utm}}\n\n인터뷰나 핸즈온 빌드도 준비해 드릴게요.\n${sigKo}`,
    ),
    t(
      "tmpl_key_attached",
      "키 동봉(바로 전달)",
      "Your {{game}} Steam key is inside 🔑",
      `Hi {{creator}},\n\nThanks for the interest in {{game}}! Here's your Steam key:\n\n{{key}}\n\nActivate via Steam → Games → Activate a Product. It's an observation game (catch the "off" detail) — short sessions, very clippable.\n\nCoverage is optional, but if you do: tagging the store page helps a lot, and we're glad to send extra keys to give away to your viewers. {{utm}}\n\nEnjoy — ping us anytime!\n${sigEn}`,
      "{{game}} Steam 키를 보내드려요 🔑",
      `안녕하세요 {{creator}}님,\n\n{{game}}에 관심 가져 주셔서 감사합니다! Steam 키 보내드려요:\n\n{{key}}\n\nSteam → 게임 → 제품 활성화에서 등록하시면 돼요. '이상한 점'을 찾는 관찰 게임이라 세션이 짧고 클립이 잘 나와요.\n\n콘텐츠 제작은 자유지만, 진행하신다면 상점 페이지 태그가 큰 도움이 되고, 시청자에게 나눠줄 증정용 키도 기꺼이 보내드려요. {{utm}}\n\n즐겨 주세요 — 언제든 연락 주시고요!\n${sigKo}`,
    ),
    t(
      "tmpl_embargo",
      "엠바고·출시일",
      "Early / exclusive {{game}} build + key for {{creator}}",
      `Hi {{creator}},\n\nWe'd love to get {{game}} in your hands before launch — here's a Steam key for an early / exclusive build from Immersed Player by Overay Inc.\n\nPlease hold coverage until: {{embargo}}\nKey: {{key}}\nStore page: {{utm}}\n\nIt's an observation game (catch the anomaly in a space). Before release we'll send assets, a changelog, and extra keys to give away to your viewers. Thanks for keeping the date!\n${sigEn}`,
      "선공개 / 독점 {{game}} 빌드 + {{creator}}님 키",
      `안녕하세요 {{creator}}님,\n\n{{game}}을(를) 출시 전에 먼저 전해드리고 싶어요 — 오버레이 Immersed Player 팀의 선공개 / 독점 빌드 Steam 키예요.\n\n공개는 다음 이후로 부탁드려요: {{embargo}}\n키: {{key}}\n상점 페이지: {{utm}}\n\n공간 속 이상현상을 찾는 관찰 게임이에요. 출시 전에 자료·변경사항과 시청자 증정용 키를 함께 보내드릴게요. 일정 지켜 주셔서 감사합니다!\n${sigKo}`,
    ),
    t(
      "tmpl_followup",
      "팔로업·리마인더",
      "Following up — {{game}} key (no rush!)",
      `Hi {{creator}},\n\nJust circling back on {{game}} — no worries if you've been busy.\n\nThe free Steam key offer still stands, and we can include keys to give away to your viewers or an early build whenever it suits you. It's a quick, clip-friendly observation game (spot the anomaly), so it's an easy one to slot in.\n\n{{utm}}\n\nHappy to send it over anytime.\n${sigEn}`,
      "다시 한번 — {{game}} 키 (천천히 보셔도 돼요!)",
      `안녕하세요 {{creator}}님,\n\n{{game}} 관련해 가볍게 다시 연락드려요 — 바쁘셨다면 전혀 괜찮아요.\n\n무료 Steam 키 제안은 유효하고, 편하실 때 시청자 증정용 키나 선공개 빌드도 함께 드릴 수 있어요. 짧고 클립 잘 나오는 관찰 게임(이상현상 찾기)이라 가볍게 끼워 넣기 좋아요.\n\n{{utm}}\n\n원하시면 언제든 보내드릴게요.\n${sigKo}`,
    ),
  ];
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
    emailTemplates: defaultEmailTemplates(),
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
      steamPartnerCookieEncrypted: "",
      steamPartnerCookieMasked: "",
      steamPartnerCookieUpdatedAt: "",
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
      graphTenantId: "",
      graphClientId: "",
      graphClientSecretEncrypted: "",
      graphClientSecretMasked: "",
      graphSendMailbox: "",
      graphAccessToken: "",
      graphAccessTokenExpiry: 0,
      youtubeClientId: "",
      youtubeClientSecretEncrypted: "",
      youtubeClientSecretMasked: "",
      youtubeRefreshTokenEncrypted: "",
      youtubeAccessToken: "",
      youtubeAccessTokenExpiry: 0,
      youtubeOAuthConnectedAt: "",
      youtubeOAuthState: "",
      youtubeAutoSyncAt: 0,
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
    discoveryCandidates: [],
    discoveryState: {
      lastRunAt: "",
      lastStatus: "never_run",
      lastMessage: "",
      lastStats: null,
      running: false,
      startedAt: "",
      endsAt: "",
      sessionFound: 0,
      progress: "",
      trigger: "",
    },
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
  data.emailTemplates ||= [];
  if (!data.emailTemplates.length) data.emailTemplates = defaultEmailTemplates();
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
  data.integrationSettings.steamPartnerCookieEncrypted ||= "";
  data.integrationSettings.steamPartnerCookieMasked ||= "";
  data.integrationSettings.steamPartnerCookieUpdatedAt ||= "";
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
  data.integrationSettings.youtubeAutoSyncAt ||= 0;
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
  data.integrationSettings.graphTenantId ||= "";
  data.integrationSettings.graphClientId ||= "";
  data.integrationSettings.graphClientSecretEncrypted ||= "";
  data.integrationSettings.graphClientSecretMasked ||= "";
  data.integrationSettings.graphSendMailbox ||= "";
  data.integrationSettings.graphAccessToken ||= "";
  data.integrationSettings.graphAccessTokenExpiry ||= 0;
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
  data.discoveryCandidates ||= [];
  data.discoveryState ||= seeded.discoveryState;
  data.discoveryState.lastStatus ||= "never_run";
  data.discoveryState.sessionFound ||= 0;
  data.discoveryState.progress ||= "";
  data.discoveryState.startedAt ||= "";
  data.discoveryState.endsAt ||= "";
  data.discoveryState.trigger ||= "";
  if (typeof data.discoveryState.running !== "boolean") data.discoveryState.running = false;
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
    creator.status = normalizeCreatorStatus(creator.status, "uncontacted");
    creator.creatorProfileId ||= upsertCreatorProfile(data, creator).id;
    // Per-game record now also carries the Steam key + distribution tracking (merged from
    // the former influencerKeys collection): one creator per game = one row.
    creator.recipientType = normalizeRecipientType(creator.recipientType || creator.platform);
    creator.channelUrl ||= "";
    creator.sentAt ||= "";
    creator.embargoAt ||= "";
    creator.steamKeyEncrypted ||= "";
    creator.steamKeyMasked ||= "";
    creator.steamActivation ||= null;
    creator.countedAsSent = Boolean(creator.countedAsSent);
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

// Per-game creator records now hold the encrypted Steam key; never return it to the client.
function sanitizeCreator(record) {
  const { steamKeyEncrypted, ...safe } = record;
  return safe;
}

// Creators that have a Steam key attached, and the subset whose key has been sent.
function keyedCreators(creators) {
  return creators.filter((creator) => creator.steamKeyMasked);
}
function sentKeyCreators(creators) {
  return creators.filter((creator) => creator.steamKeyMasked && ["sent", "review"].includes(creator.status));
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
        keys: keyedCreators(creators).length,
        keysSent: sentKeyCreators(creators).length,
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

function buildDashboard(data, gameId = "all", clientDate = "") {
  const metrics = scopedItems(data.steamDailyMetrics, gameId);
  const campaigns = scopedItems(data.campaigns, gameId);
  const creators = scopedItems(data.creators, gameId);
  const latestDate = latestMetricDate(metrics);
  // The headline cards report YESTERDAY specifically (Steam financials lag ~1 day);
  // empty when yesterday has no data. Use the caller's local date if provided.
  const baseToday = /^\d{4}-\d{2}-\d{2}$/.test(clientDate) ? clientDate : toDateString(new Date());
  const reportDate = addDays(baseToday, -1);
  const todayMetrics = metrics.filter((metric) => metric.date === reportDate);
  const last7Metrics = metrics.filter((metric) => withinLastDays(metric.date, reportDate, 7));
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
    .filter((creator) => creator.status === "uncontacted")
    .sort((a, b) => toNumber(b.fitScore) - toNumber(a.fitScore))
    .slice(0, 12);

  // Daily time series for the dashboard chart (last 30 days). Scoped by gameId,
  // so "all" is the aggregate across games and a specific game is that game.
  const dayMap = new Map();
  for (const metric of metrics) {
    if (!metric.date) continue;
    if (!dayMap.has(metric.date)) {
      dayMap.set(metric.date, { date: metric.date, wishlists: 0, purchases: 0, revenue: 0, visits: 0 });
    }
    const day = dayMap.get(metric.date);
    day.wishlists += toNumber(metric.wishlists);
    day.purchases += toNumber(metric.purchases);
    day.revenue += toNumber(metric.revenue);
    day.visits += toNumber(metric.visits);
  }
  const trend = [...dayMap.values()]
    .filter((day) => withinLastDays(day.date, latestDate, 30))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ ...day, revenue: Number(day.revenue.toFixed(2)) }));

  // Conversion funnel over all available data for this scope: 방문 → 위시 → 구매.
  // Steam's wishlist/financials API has no visit/impression data (visits come
  // only from an imported Steamworks traffic CSV), so visit-based rates appear
  // only when visits exist; wishlist→purchase is always available from the API.
  const funnelTotals = aggregateMetrics(metrics);
  const funnel = {
    visits: funnelTotals.visits,
    wishlists: funnelTotals.wishlists,
    purchases: funnelTotals.purchases,
    revenue: Number(funnelTotals.revenue.toFixed(2)),
    hasVisits: funnelTotals.visits > 0,
    visitToWishlist: rate(funnelTotals.wishlists, funnelTotals.visits),
    wishlistToPurchase: rate(funnelTotals.purchases, funnelTotals.wishlists),
    visitToPurchase: rate(funnelTotals.purchases, funnelTotals.visits),
  };

  return {
    latestDate,
    reportDate,
    trend,
    funnel,
    selectedGameId: gameId,
    selectedGameName: gameId === "all" ? "All Games" : gameNameFor(data, gameId),
    portfolio: buildPortfolio(data),
    today: {
      ...today,
      revenue: Number(today.revenue.toFixed(2)),
      wishlistRate: rate(today.wishlists, today.visits),
      purchaseRate: rate(today.purchases, today.visits),
      wishlistToPurchaseRate: rate(today.purchases, today.wishlists),
    },
    last7: {
      ...last7,
      revenue: Number(last7.revenue.toFixed(2)),
      wishlistRate: rate(last7.wishlists, last7.visits),
      purchaseRate: rate(last7.purchases, last7.visits),
      wishlistToPurchaseRate: rate(last7.purchases, last7.wishlists),
    },
    topCampaigns,
    contactQueue,
    summary: {
      games: activeGames(data).length,
      campaigns: campaigns.length,
      creators: creators.length,
      keys: keyedCreators(creators).length,
      keysSent: sentKeyCreators(creators).length,
      videosUploaded: creators.filter((creator) => creator.status === "review").length,
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
  profile.channels = normalizeChannels(profile.channels);
  // Primary platform reflects the first channel when present.
  profile.platform = profile.channels[0]?.platform || profile.platform || "YouTube";
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
    profile.channels = normalizeChannels([...(profile.channels || []), ...channelsFromInput(input)]);
    profile.updatedAt = now;
    normalizeCreatorProfile(profile);
    return profile;
  }

  const created = {
    id: input.id || makeId("profile", input.channelName || input.name || input.handle || input.email || "creator"),
    channelName: String(input.channelName || input.name || input.recipientName || input.handle || input.email || "Untitled Creator").trim(),
    handle: input.handle || input.creatorHandle || "",
    platform: input.platform || "YouTube",
    channels: channelsFromInput(input),
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

function platformFromRecipientType(type) {
  switch (normalizeRecipientType(type)) {
    case "streamer":
      return "Twitch";
    case "curator":
      return "Steam";
    case "press":
      return "Web";
    default:
      return "YouTube";
  }
}

// A creator may run several channels (YouTube + TikTok + Twitch …) under one profile.
function platformFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return "YouTube";
  if (/tiktok\.com/.test(u)) return "TikTok";
  if (/twitch\.tv/.test(u)) return "Twitch";
  if (/steampowered\.com|steamcommunity\.com/.test(u)) return "Steam";
  if (/twitter\.com|x\.com/.test(u)) return "X";
  if (/instagram\.com/.test(u)) return "Instagram";
  if (/reddit\.com/.test(u)) return "Reddit";
  if (/discord\.(gg|com)/.test(u)) return "Discord";
  if (/facebook\.com/.test(u)) return "Facebook";
  return "Web";
}

// Normalizes a profile's channels into a deduped [{platform, url}] list. Accepts an array of
// objects/strings or a delimited string (newline/comma/pipe).
function normalizeChannels(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value.map((c) => (typeof c === "string" ? { url: c } : c || {}));
  } else if (value) {
    items = String(value)
      .split(/[\n,|]/)
      .map((u) => ({ url: u }));
  }
  const seen = new Set();
  const out = [];
  for (const c of items) {
    const url = String(c.url || c.href || "").trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform: c.platform ? String(c.platform) : platformFromUrl(url), url });
  }
  return out;
}

function channelsFromInput(input) {
  return normalizeChannels(input.channels || input.links || input.channelUrls || input.channelUrl || input.url || []);
}

// Increments the campaign's keysSent counter once per creator whose key has been sent
// (guarded by creator.countedAsSent so later status edits can't double-count).
function applyCreatorKeySideEffects(data, creator) {
  const isSent = creator.steamKeyMasked && ["sent", "review"].includes(creator.status);
  if (isSent && !creator.countedAsSent) {
    creator.countedAsSent = true;
    if (creator.campaignId) {
      const campaign = data.campaigns.find((item) => item.id === creator.campaignId && item.gameId === creator.gameId);
      if (campaign) {
        campaign.keysSent = toNumber(campaign.keysSent) + 1;
        campaign.updatedAt = nowIso();
      }
    }
  }
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

// Replaces {{placeholder}} tokens; unknown/empty values become a visible [token] so the
// sender notices to fill them in the editable composer.
function fillTemplate(str, vars) {
  return String(str || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value !== undefined && value !== null && value !== "" ? String(value) : `[${key}]`;
  });
}

// Korean is the base language; emails can also be sent in EN/JA/DE/ZH. Templates
// always carry KO+EN; JA/DE/ZH are opt-in. Missing languages are AI-translated
// from the Korean base on the fly.
const SUPPORTED_LANGS = ["ko", "en", "ja", "de", "zh"];
const LANG_SUFFIX = { ko: "Ko", en: "En", ja: "Ja", de: "De", zh: "Zh" };

async function buildEmailDraft(data, input = {}) {
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
  const greetingName = profile.channelName || profile.handle || "there";
  const keyValue = creator?.steamKeyEncrypted ? decryptSecret(creator.steamKeyEncrypted) : "";
  const vars = {
    creator: greetingName,
    game: game.name,
    key: keyValue,
    utm: link,
    embargo: creator?.embargoAt || "",
    genre: game.genre || "",
  };
  const template = input.templateId ? data.emailTemplates?.find((item) => item.id === input.templateId) : null;
  const lang = SUPPORTED_LANGS.includes(input.lang) ? input.lang : "en";
  let subject;
  let body;
  if (template) {
    const suffix = LANG_SUFFIX[lang];
    let subjRaw = template[`subject${suffix}`] || "";
    let bodyRaw = template[`body${suffix}`] || "";
    // For languages the template doesn't store (opt-in JA/DE/ZH, or EN missing),
    // translate the Korean base (then English) into the target language via AI.
    if (lang !== "ko" && (!subjRaw || !bodyRaw)) {
      const baseSubject = template.subjectKo || template.subjectEn || "";
      const baseBody = template.bodyKo || template.bodyEn || "";
      try {
        if (!bodyRaw && baseBody) bodyRaw = await translateText({ text: baseBody, targetLang: lang });
        if (!subjRaw && baseSubject) subjRaw = await translateText({ text: baseSubject, targetLang: lang });
      } catch {
        // AI unavailable — fall through to the base text below.
      }
    }
    if (!subjRaw) subjRaw = template.subjectKo || template.subjectEn || "";
    if (!bodyRaw) bodyRaw = template.bodyKo || template.bodyEn || "";
    subject = input.subject || fillTemplate(subjRaw, vars);
    body = input.body || fillTemplate(bodyRaw, vars);
  } else {
    subject = input.subject || `${game.name} Steam key for creator preview`;
    body =
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
        "Immersed Player, Overay Inc.",
      ].join("\n");
  }
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
  const storedSteamPartnerCookie = decryptSecret(settings.steamPartnerCookieEncrypted);
  const storedYoutubeKey = decryptSecret(settings.youtubeApiKeyEncrypted);
  const storedYoutubeSecret = decryptSecret(settings.youtubeClientSecretEncrypted);
  const storedYoutubeRefresh = decryptSecret(settings.youtubeRefreshTokenEncrypted);
  const storedRedditSecret = decryptSecret(settings.redditClientSecretEncrypted);
  const storedSmtpPass = decryptSecret(settings.smtpPassEncrypted);
  const storedGraphSecret = decryptSecret(settings.graphClientSecretEncrypted);
  const smtpUser = settings.smtpUser || SMTP_USER;
  const graphTenantId = settings.graphTenantId || GRAPH_TENANT_ID;
  const graphClientId = settings.graphClientId || GRAPH_CLIENT_ID;
  const graphClientSecret = storedGraphSecret || GRAPH_CLIENT_SECRET;
  const graphSendMailbox = settings.graphSendMailbox || GRAPH_SEND_MAILBOX;
  return {
    steamFinancialApiKey: storedSteamKey || STEAM_FINANCIAL_API_KEY,
    steamKeySource: storedSteamKey ? "web" : STEAM_FINANCIAL_API_KEY ? "env" : "missing",
    steamPartnerCookie: storedSteamPartnerCookie,
    steamPartnerCookieConfigured: Boolean(storedSteamPartnerCookie),
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
    graphTenantId,
    graphClientId,
    graphClientSecret,
    graphSendMailbox,
    graphClientSecretMasked: settings.graphClientSecretMasked || (GRAPH_CLIENT_SECRET ? maskSecret(GRAPH_CLIENT_SECRET) : ""),
    graphConfigured: Boolean(graphTenantId && graphClientId && graphClientSecret && graphSendMailbox),
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
      partnerCookieConfigured: config.steamPartnerCookieConfigured,
      partnerCookieMasked: settings.steamPartnerCookieMasked || "",
      partnerCookieUpdatedAt: settings.steamPartnerCookieUpdatedAt || "",
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
      graphTenantId: settings.graphTenantId || "",
      graphClientId: settings.graphClientId || "",
      graphSendMailbox: settings.graphSendMailbox || "",
      graphClientSecretMasked: settings.graphClientSecretMasked || "",
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

  if (input.clearSteamPartnerCookie) {
    settings.steamPartnerCookieEncrypted = "";
    settings.steamPartnerCookieMasked = "";
    settings.steamPartnerCookieUpdatedAt = "";
  } else if (input.steamPartnerCookie) {
    const cookie = normalizeSteamCookie(input.steamPartnerCookie);
    settings.steamPartnerCookieEncrypted = encryptSecret(cookie);
    settings.steamPartnerCookieMasked = maskSecret(cookie.replace(/\s+/g, ""));
    settings.steamPartnerCookieUpdatedAt = nowIso();
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
  if (input.emailSendMode !== undefined) settings.emailSendMode = ["smtp", "log", "graph"].includes(input.emailSendMode) ? input.emailSendMode : "smtp";

  if (input.graphTenantId !== undefined) settings.graphTenantId = String(input.graphTenantId).trim();
  if (input.graphClientId !== undefined) settings.graphClientId = String(input.graphClientId).trim();
  if (input.graphSendMailbox !== undefined) settings.graphSendMailbox = String(input.graphSendMailbox).trim();
  if (input.clearGraphClientSecret) {
    settings.graphClientSecretEncrypted = "";
    settings.graphClientSecretMasked = "";
    settings.graphAccessToken = "";
    settings.graphAccessTokenExpiry = 0;
  } else if (input.graphClientSecret) {
    settings.graphClientSecretEncrypted = encryptSecret(input.graphClientSecret);
    settings.graphClientSecretMasked = maskSecret(input.graphClientSecret);
    settings.graphAccessToken = "";
    settings.graphAccessTokenExpiry = 0;
  }
  // Tenant/client/mailbox changes also invalidate any cached app token.
  if (input.graphTenantId !== undefined || input.graphClientId !== undefined) {
    settings.graphAccessToken = "";
    settings.graphAccessTokenExpiry = 0;
  }
  settings.updatedAt = nowIso();
  return publicSettings(data);
}

function emailConfigured(dataOrConfig) {
  const config = dataOrConfig?.smtpHost !== undefined ? dataOrConfig : effectiveIntegrationConfig(dataOrConfig || {});
  if (config.emailSendMode === "graph") return Boolean(config.graphConfigured);
  return Boolean(config.smtpHost && config.smtpPort && config.emailFrom);
}

function buildEmailStatus(data) {
  const config = effectiveIntegrationConfig(data || {});
  const isGraph = config.emailSendMode === "graph";
  return {
    configured: emailConfigured(config),
    mode: config.emailSendMode,
    source: isGraph ? (config.graphConfigured ? "graph" : "missing") : config.smtpSource,
    host: isGraph ? "graph.microsoft.com" : config.smtpHost ? config.smtpHost : "missing",
    port: isGraph ? 443 : config.smtpPort,
    from: isGraph ? config.graphSendMailbox || "missing" : config.emailFrom ? config.emailFrom : "missing",
    auth: isGraph ? (config.graphConfigured ? "app-only" : "not_configured") : config.smtpUser && config.smtpPass ? "configured" : "not_configured",
    secure: isGraph ? true : config.smtpSecure,
    starttls: isGraph ? true : config.smtpStarttls,
    passwordMasked: isGraph ? config.graphClientSecretMasked : config.smtpPassMasked,
    graphMailbox: config.graphSendMailbox || "",
    graphTenantId: config.graphTenantId || "",
    graphClientId: config.graphClientId || "",
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

// Microsoft Graph app-only (client credentials) token, cached on settings until
// ~1 min before expiry. Mirrors ensureRedditToken.
async function ensureGraphToken(data) {
  const settings = data.integrationSettings;
  const config = effectiveIntegrationConfig(data);
  if (!config.graphTenantId || !config.graphClientId || !config.graphClientSecret) return "";
  if (settings.graphAccessToken && settings.graphAccessTokenExpiry && Date.now() < settings.graphAccessTokenExpiry - 60000) {
    return settings.graphAccessToken;
  }
  const response = await fetch(graphTokenUrl(config.graphTenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.graphClientId,
      client_secret: config.graphClientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error_description || body?.error || `Graph 토큰 발급 실패 (${response.status})`);
  }
  settings.graphAccessToken = body.access_token;
  settings.graphAccessTokenExpiry = Date.now() + toNumber(body.expires_in, 3600) * 1000;
  return settings.graphAccessToken;
}

// Send via Graph `sendMail` from a fixed mailbox (Application Mail.Send permission,
// scoped to that mailbox with an ApplicationAccessPolicy). 202 = accepted.
async function sendEmailViaGraph(data, config, { to, subject, body }) {
  const token = await ensureGraphToken(data);
  if (!token) throw new Error("Graph 발송 설정이 없습니다.");
  const mailbox = config.graphSendMailbox;
  if (!mailbox) throw new Error("Graph 발신 사서함이 설정되지 않았습니다.");
  const payload = {
    message: {
      subject: subject || "",
      body: { contentType: "Text", content: body || "" },
      toRecipients: [{ emailAddress: { address: addressOnly(to) } }],
      ...(config.emailReplyTo ? { replyTo: [{ emailAddress: { address: addressOnly(config.emailReplyTo) } }] } : {}),
    },
    saveToSentItems: true,
  };
  const response = await fetch(`${GRAPH_API_BASE}/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 202) {
    return { provider: "graph", response: `Graph accepted (${mailbox})` };
  }
  const errText = await response.text().catch(() => "");
  let detail = errText;
  try {
    detail = JSON.parse(errText)?.error?.message || errText;
  } catch {
    /* keep raw text */
  }
  throw new Error(`Graph sendMail 실패 (${response.status}): ${String(detail).slice(0, 300)}`);
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
  if (creator && creator.status === "uncontacted") {
    creator.status = "sent";
    creator.updatedAt = nowIso();
  }
  const campaign = log.campaignId ? data.campaigns.find((item) => item.id === log.campaignId && (!log.gameId || item.gameId === log.gameId)) : undefined;
  if (campaign) {
    campaign.sentEmails = toNumber(campaign.sentEmails) + 1;
    campaign.updatedAt = nowIso();
  }
}

async function sendOutreachEmail(data, input = {}) {
  const draft = input.draft || (await buildEmailDraft(data, input));
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
  const isGraph = config.emailSendMode === "graph";
  const provider = isGraph ? "graph" : "smtp";
  if (!emailConfigured(config)) {
    const log = addOutreachLog(data, {
      ...draft,
      status: "blocked",
      provider,
      message: isGraph
        ? "Graph 발송 설정이 없어 실제 발송하지 않았습니다."
        : "SMTP 설정이 없어 실제 발송하지 않았습니다.",
    });
    return { status: "blocked", log, message: log.message, emailStatus: buildEmailStatus(data) };
  }
  try {
    const result = isGraph ? await sendEmailViaGraph(data, config, draft) : await sendEmailViaSmtp(config, draft);
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
      provider,
      error: error.message || (isGraph ? "Graph send failed." : "SMTP send failed."),
    });
    return { status: "failed", log, message: log.error };
  }
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
    links: firstValue(row, ["channels", "links", "channelurl", "channelurls", "url", "urls", "link"]),
  };
}

function creatorProfilePreviewIdentity(input) {
  const email = String(input.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const handle = String(input.handle || "").trim().toLowerCase();
  if (handle) return `handle:${String(input.platform || "").trim().toLowerCase()}:${handle}`;
  return `name:${String(input.channelName || "").trim().toLowerCase()}`;
}

// The shared-DB importer uses ascii-normalized headers, so a Korean key-tracker CSV
// (No,Key,대상,…) collapses to a "key" column with no recognizable creator column. Detect
// that and redirect the user instead of emitting one "missing channelName" warning per row.
function assertNotKeyTrackerCsv(rows) {
  const cols = new Set(Object.keys(rows[0] || {}));
  const hasCreatorCol = ["channelname", "channel", "name", "creator", "handle", "username", "email", "mail", "contact"].some((c) => cols.has(c));
  if (cols.has("key") && !hasCreatorCol) {
    throw new Error("이 CSV는 키 트래커(엑셀) 형식입니다. '게임별 크리에이터'의 CSV 가져오기를 사용하세요.");
  }
}

function previewCreatorCsv(data, csvText) {
  const rows = parseCsv(csvText);
  assertNotKeyTrackerCsv(rows);
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
  assertNotKeyTrackerCsv(rows);
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

// Maps a single CSV header cell (Korean spreadsheet headers included) to a key field name.
// normalizeHeader strips non-ascii, so Korean headers need their own resolver here.
function keyCsvField(header) {
  const h = String(header || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s/()·.\-_]+/g, "");
  const map = {
    key: "steamKey", 키: "steamKey", 스팀키: "steamKey", steamkey: "steamKey", cdkey: "steamKey", code: "steamKey", 코드: "steamKey",
    대상: "recipientName", 채널: "recipientName", 채널명: "recipientName", name: "recipientName", creator: "recipientName", recipient: "recipientName", recipientname: "recipientName", 수신자: "recipientName",
    대상구분: "recipientType", 구분: "recipientType", 유형: "recipientType", type: "recipientType", recipienttype: "recipientType",
    연락처: "recipientEmail", 이메일: "recipientEmail", email: "recipientEmail", contact: "recipientEmail", mail: "recipientEmail", recipientemail: "recipientEmail",
    국가언어: "country", 국가: "country", 언어: "country", country: "country", region: "country", language: "country", lang: "country",
    발송일: "sentAt", 발송: "sentAt", senddate: "sentAt", sentdate: "sentAt", sent: "sentAt", sentat: "sentAt", 발송날짜: "sentAt",
    엠바고kst: "embargoAt", 엠바고: "embargoAt", embargo: "embargoAt", embargoat: "embargoAt", embargokst: "embargoAt",
    상태: "status", status: "status", state: "status",
    채널프로필url: "channelUrl", 채널url: "channelUrl", 프로필url: "channelUrl", url: "channelUrl", channelurl: "channelUrl", link: "channelUrl", 링크: "channelUrl", profile: "channelUrl", 프로필: "channelUrl",
    메모: "note", note: "note", notes: "note", memo: "note", comment: "note", 비고: "note",
  };
  return map[h] || "";
}

// Parses an Excel-exported key tracker CSV into field-keyed row objects. Tolerant of leading
// title rows: it scans for the first row that looks like a header (has Key or a labelled
// recipient column), so a raw export with banner rows above the table still imports.
function parseKeyCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV에 헤더와 최소 1개 데이터 행이 필요합니다.");
  }
  const headerIdx = lines.findIndex((line) => {
    const fields = parseCsvLine(line).map(keyCsvField);
    return fields.includes("steamKey") || (fields.includes("recipientName") && fields.filter(Boolean).length >= 2);
  });
  if (headerIdx < 0) {
    throw new Error("CSV 헤더를 인식하지 못했습니다. (Key / 대상 / 상태 등 컬럼이 필요합니다)");
  }
  const headers = parseCsvLine(lines[headerIdx]).map(keyCsvField);
  return lines
    .slice(headerIdx + 1)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = {};
      headers.forEach((field, index) => {
        if (field && !row[field]) row[field] = (values[index] ?? "").trim();
      });
      return row;
    })
    .filter((row) => row.steamKey || row.recipientName || row.recipientEmail);
}

function keyInputFromCsvRow(row) {
  const rawKey = String(row.steamKey || "").trim();
  return {
    channelName: String(row.recipientName || row.recipientEmail || "Unassigned recipient").trim(),
    email: String(row.recipientEmail || "").trim(),
    recipientType: normalizeRecipientType(row.recipientType),
    country: String(row.country || "").trim(),
    channelUrl: String(row.channelUrl || "").trim(),
    sentAt: String(row.sentAt || "").trim(),
    embargoAt: String(row.embargoAt || "").trim(),
    status: normalizeCreatorStatus(row.status, "uncontacted"),
    note: String(row.note || "").trim(),
    steamKey: rawKey,
    steamKeyMasked: rawKey ? maskSteamKey(rawKey) : "",
  };
}

// Finds an existing per-game creator that matches an imported row, so re-imports update in
// place rather than duplicating. Matches on the (masked) Steam key first, then channel name.
function findExistingGameCreator(data, gameId, input) {
  const masked = input.steamKeyMasked;
  if (masked) {
    const byKey = data.creators.find((c) => c.gameId === gameId && c.steamKeyMasked && c.steamKeyMasked === masked);
    if (byKey) return byKey;
  }
  const name = input.channelName.trim().toLowerCase();
  if (name && name !== "unassigned recipient") {
    return data.creators.find((c) => c.gameId === gameId && String(c.channelName || "").trim().toLowerCase() === name);
  }
  return undefined;
}

function previewKeyCsv(data, gameId, csvText) {
  const rows = parseKeyCsv(csvText);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const seen = new Set();
  let newRows = 0;
  let updateRows = 0;
  let duplicateRows = 0;
  const warnings = [];
  const previewRows = [];
  rows.forEach((row, index) => {
    const input = keyInputFromCsvRow(row);
    if (!input.steamKey && !input.channelName) {
      warnings.push(`행 ${index + 1}: Key 또는 대상이 비어 건너뜁니다.`);
      return;
    }
    const identity = (input.steamKeyMasked || input.channelName).toLowerCase();
    if (seen.has(identity)) {
      duplicateRows += 1;
      return;
    }
    seen.add(identity);
    if (findExistingGameCreator(data, gameId, input)) updateRows += 1;
    else newRows += 1;
    previewRows.push({
      channelName: input.channelName,
      recipientType: input.recipientType,
      email: input.email,
      country: input.country,
      sentAt: input.sentAt,
      embargoAt: input.embargoAt,
      status: input.status,
      channelUrl: input.channelUrl,
      steamKeyMasked: input.steamKeyMasked || "(없음)",
      note: input.note,
    });
  });
  return { columns, totalRows: rows.length, newRows, updateRows, duplicateRows, warnings, previewRows: previewRows.slice(0, 8) };
}

function importKeyCsv(data, gameId, csvText) {
  const rows = parseKeyCsv(csvText);
  const seen = new Set();
  let imported = 0;
  let updated = 0;
  let skippedDuplicates = 0;
  rows.forEach((row) => {
    const input = keyInputFromCsvRow(row);
    if (!input.steamKey && !input.channelName) return;
    const identity = (input.steamKeyMasked || input.channelName).toLowerCase();
    if (seen.has(identity)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(identity);
    // Keep the shared creator DB (creatorProfiles) in sync — pass profile-only fields, never status.
    const profile = upsertCreatorProfile(data, {
      channelName: input.channelName,
      name: input.channelName,
      email: input.email,
      country: input.country,
      platform: platformFromRecipientType(input.recipientType),
    });
    const existing = findExistingGameCreator(data, gameId, input);
    if (existing) {
      existing.channelName = input.channelName || existing.channelName;
      existing.email = input.email || existing.email;
      existing.recipientType = input.recipientType;
      existing.country = input.country || existing.country;
      existing.channelUrl = input.channelUrl || existing.channelUrl;
      existing.sentAt = input.sentAt || existing.sentAt;
      existing.embargoAt = input.embargoAt || existing.embargoAt;
      existing.note = input.note || existing.note;
      existing.status = input.status;
      existing.creatorProfileId ||= profile.id;
      if (input.steamKey) {
        existing.steamKeyEncrypted = encryptSteamKey(input.steamKey);
        existing.steamKeyMasked = input.steamKeyMasked;
      }
      existing.updatedAt = nowIso();
      applyCreatorKeySideEffects(data, existing);
      updated += 1;
      return;
    }
    const creator = {
      id: makeId("creator", input.channelName),
      creatorProfileId: profile.id,
      gameId,
      channelName: input.channelName,
      handle: profile.handle || "",
      platform: platformFromRecipientType(input.recipientType),
      recipientType: input.recipientType,
      email: input.email,
      country: input.country,
      channelUrl: input.channelUrl,
      tags: [],
      subscribers: 0,
      averageViews: 0,
      fitScore: 0,
      status: input.status,
      campaignId: "",
      utmLink: "",
      sentAt: input.sentAt || (["sent", "review"].includes(input.status) ? toDateString(new Date()) : ""),
      embargoAt: input.embargoAt,
      steamKeyEncrypted: input.steamKey ? encryptSteamKey(input.steamKey) : "",
      steamKeyMasked: input.steamKeyMasked,
      steamActivation: null,
      countedAsSent: false,
      note: input.note,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.creators.push(creator);
    applyCreatorKeySideEffects(data, creator);
    imported += 1;
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

const STEAM_QUERY_CDKEY_URL = "https://partner.steamgames.com/querycdkey/cdkey";
const STEAM_PARTNER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Accepts either a raw Cookie header string (sessionid=...; steamLoginSecure=...; ...) or a
// single cookie line copied from devtools, and normalizes it to a clean one-line header.
function normalizeSteamCookie(value) {
  return String(value || "")
    .replace(/^cookie:\s*/i, "")
    .replace(/\s*[\r\n]+\s*/g, "; ")
    .replace(/;\s*;+/g, "; ")
    .trim()
    .replace(/;$/, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Parses the HTML returned by the partner querycdkey page. The activation table lives under
// an "Activation Details" heading; the first cell is the status ("Activated" / "Not Activated"
// / "Key not found"), the second (when activated) is the owning Steam account.
function parseCdKeyHtml(html) {
  const text = String(html || "");
  // Detect being bounced to a login page (expired / missing session cookie).
  if (/login|sign in|steamcommunity\.com\/openid|j_username/i.test(text) && !/Activation Details/i.test(text)) {
    return { authError: true };
  }
  const marker = text.split(/<h2[^>]*>\s*Activation Details\s*<\/h2>/i)[1];
  if (!marker) {
    // Some responses report an unknown/foreign key inline without the table.
    if (/not been activated|has not been activated/i.test(text)) return { activated: false, account: "", status: "Not activated" };
    if (/not a valid|invalid|not found|isn't a valid/i.test(text)) return { activated: false, account: "", status: "Key not found", notFound: true };
    return { activated: false, account: "", status: stripHtml(text).slice(0, 120) || "Unknown" };
  }
  const cells = [...marker.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
  const status = cells[0] || "";
  const activated = /^activated/i.test(status);
  return {
    activated,
    account: activated ? cells[1] || "" : "",
    status: status || (activated ? "Activated" : "Not activated"),
  };
}

// Queries a single Steam CD key against the partner site using the stored session cookie.
// Returns { ok, authError, activated, account, status } — never throws for HTTP/parse issues.
async function querySteamCdKey(cookie, cdkey) {
  const clean = String(cdkey || "").trim();
  if (!clean) return { ok: false, error: "키 값이 없습니다." };
  const url = new URL(STEAM_QUERY_CDKEY_URL);
  url.searchParams.set("cdkey", clean);
  url.searchParams.set("method", "Query");
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Cookie: cookie,
        "User-Agent": STEAM_PARTNER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, error: `Steam 요청 실패: ${error.message}` };
  }
  // 30x to a login host means the session cookie is missing/expired.
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, authError: true, error: "Steam 파트너 세션이 만료되었습니다. 쿠키를 다시 붙여넣어 주세요." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, authError: true, error: "Steam 파트너 인증 실패. 쿠키를 다시 붙여넣어 주세요." };
  }
  const body = await response.text().catch(() => "");
  const parsed = parseCdKeyHtml(body);
  if (parsed.authError) {
    return { ok: false, authError: true, error: "Steam 파트너 세션이 만료되었습니다. 쿠키를 다시 붙여넣어 주세요." };
  }
  return { ok: true, activated: parsed.activated, account: parsed.account, status: parsed.status, notFound: parsed.notFound };
}

// Runs querySteamCdKey across a list of creator records that have a Steam key (sequentially,
// with a small delay so we don't hammer the partner site) and writes the result onto each
// creator's steamActivation field.
async function checkActivationForCreators(data, creators) {
  const config = effectiveIntegrationConfig(data);
  const cookie = config.steamPartnerCookie;
  if (!cookie) {
    return { ok: false, authError: true, message: "Steam 파트너 세션 쿠키가 설정되지 않았습니다. 설정 탭에서 등록하세요.", checked: 0, activated: 0, total: creators.length };
  }
  let checked = 0;
  let activatedCount = 0;
  let lastError = "";
  for (const creator of creators) {
    const cdkey = decryptSecret(creator.steamKeyEncrypted);
    if (!cdkey) continue;
    const result = await querySteamCdKey(cookie, cdkey);
    if (result.authError) {
      return { ok: false, authError: true, message: result.error, checked, activated: activatedCount, total: creators.length };
    }
    if (!result.ok) {
      lastError = result.error || "조회 실패";
      continue;
    }
    creator.steamActivation = {
      activated: result.activated,
      account: result.account || "",
      status: result.status || "",
      notFound: Boolean(result.notFound),
      checkedAt: nowIso(),
      source: "steam",
    };
    creator.updatedAt = nowIso();
    checked += 1;
    if (result.activated) activatedCount += 1;
    // Gentle pacing between requests.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return {
    ok: true,
    checked,
    activated: activatedCount,
    total: creators.length,
    message: lastError && !checked ? lastError : "",
    error: lastError && !checked ? lastError : "",
  };
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
  const keys = keyedCreators(creators);
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
    creators: data.creators.map(sanitizeCreator),
    keys: keyedCreators(data.creators).map(sanitizeCreator),
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

// Once a day, snapshot every YouTube channel's public stats (subscribers/views)
// so the trend charts fill in automatically without manual syncing.
async function runYoutubeAutoSnapshot(data) {
  const settings = data.integrationSettings;
  const config = effectiveIntegrationConfig(data);
  if (!config.youtubeApiKey || !data.youtubeChannels.length) return false;
  const lastAt = Number(settings.youtubeAutoSyncAt || 0);
  if (lastAt && Date.now() - lastAt < 23 * 60 * 60 * 1000) return false;
  try {
    await syncYoutubeChannels(data, "all");
  } catch (error) {
    console.error("YouTube auto-snapshot failed:", error.message || error);
  }
  settings.youtubeAutoSyncAt = Date.now();
  return true;
}

async function checkScheduledSync() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const data = await readData();
    const result = await runScheduledSync(data);
    const youtubeChanged = await runYoutubeAutoSnapshot(data);
    if (!result.skipped || youtubeChanged) await writeData(data);
  } catch (error) {
    console.error("Scheduled sync check failed:", error.message || error);
  } finally {
    schedulerRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Creator discovery bot — server glue around src/discovery/*.
// The bot SEARCHES (YouTube/Twitch/web) + gemma4 analyzes; it only fills a
// review queue (data.discoveryCandidates). Sending stays manual by design.
// ---------------------------------------------------------------------------
function discoveryConfigForServer(data) {
  const config = effectiveIntegrationConfig(data);
  return {
    youtube: { apiKey: config.youtubeApiKey },
    twitch: { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET },
    web: { provider: WEB_SEARCH_PROVIDER, apiKey: WEB_SEARCH_API_KEY },
  };
}

function discoverySourceFlags(data) {
  const config = effectiveIntegrationConfig(data);
  return {
    youtube: Boolean(config.youtubeApiKey),
    twitch: Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
    web: Boolean(WEB_SEARCH_PROVIDER && WEB_SEARCH_API_KEY),
  };
}

// Stable identity for a candidate so re-runs update instead of duplicating.
function discoveryStableKey(c) {
  if (c.platform && c.externalId) return `${c.platform}:${c.externalId}`.toLowerCase();
  if (c.url) return c.url.toLowerCase().replace(/\/+$/, "");
  return `${c.platform || "?"}:${String(c.channelName || "").toLowerCase()}`;
}

// Persisted shape of a candidate — drops the bulky scrapedText, caps description.
function sanitizeDiscoveryFields(c) {
  return {
    source: c.source || "",
    sources: Array.isArray(c.sources) ? c.sources : c.source ? [c.source] : [],
    platform: c.platform || "",
    externalId: c.externalId || "",
    channelName: c.channelName || "",
    handle: c.handle || "",
    url: c.url || "",
    description: String(c.description || "").slice(0, 1000),
    subscribers: toNumber(c.subscribers),
    email: c.email || "",
    channelType: c.channelType || "",
    audience: c.audience || "",
    contentTone: c.contentTone || "",
    languages: c.languages || "",
    fitScore: toNumber(c.fitScore),
    fitReason: c.fitReason || "",
    tags: Array.isArray(c.tags) ? c.tags : [],
    isKnown: Boolean(c.isKnown),
    scrapedUrls: Array.isArray(c.scrapedUrls) ? c.scrapedUrls : [],
    error: c.error || "",
  };
}

// Merge a run's candidates into the stored queue. Existing rows that are still
// "discovered" get refreshed; "dismissed"/"approved" rows are left alone (so a
// re-run never resurrects something the user already triaged).
function mergeDiscoveryCandidates(data, found) {
  const byKey = new Map((data.discoveryCandidates || []).map((c) => [c.key, c]));
  for (const f of found) {
    const key = discoveryStableKey(f);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.status === "discovered") {
        Object.assign(existing, sanitizeDiscoveryFields(f), { key, id: existing.id, status: "discovered", updatedAt: nowIso() });
      }
      continue;
    }
    const row = {
      id: makeId("disc", f.channelName || f.platform || "creator"),
      key,
      ...sanitizeDiscoveryFields(f),
      status: "discovered",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.discoveryCandidates.push(row);
    byKey.set(key, row);
  }
}

// One short, awaited pass — used by the dashboard's "quick run" button. Bounded
// by a soft deadline so it never hangs the HTTP request for long.
async function runDiscoveryQuick(data, { seeds = [], perSeed = 8, minFitScore = 0, expandCount = 0, leadDepth = 0, analyze = true } = {}) {
  const seedList = seeds.length ? seeds : discoverySeeds([]);
  const result = await runDiscovery(seedList, {
    config: discoveryConfigForServer(data),
    gameContext: discoveryGameContext(),
    knownProfiles: data.creatorProfiles || [],
    perSeed,
    minFitScore,
    expandCount,
    leadDepth,
    analyze,
    enrich: analyze,
    deadline: Date.now() + 120_000,
  });
  mergeDiscoveryCandidates(data, result.candidates);
  data.discoveryState = {
    ...data.discoveryState,
    lastRunAt: nowIso(),
    lastStatus: "ok",
    lastMessage: `발견 ${result.stats.kept}명 · 이메일 ${result.stats.withEmail} · 신규 ${result.stats.newCreators}`,
    lastStats: result.stats,
  };
  return result;
}

// --- Long / windowed background session -------------------------------------
// A session keeps discovering until `overallDeadline` (e.g. "+3h" or "until
// 09:00"). It works in chunks so progress persists incrementally and a crash
// loses at most one chunk. When a chunk's queue drains, gemma proposes a fresh
// seed batch so the bot stays productive across the whole window.
let discoveryRunning = false; // authoritative at runtime (vs the persisted flag)
let discoveryStop = false;

async function runDiscoverySession({ baseSeeds = [], overallDeadline, perSeed = 8, minFitScore = 0, trigger = "manual" } = {}) {
  if (discoveryRunning) return { started: false, reason: "already_running" };
  discoveryRunning = true;
  discoveryStop = false;

  let renderImpl = null;
  if (discoveryUseRenderer()) {
    try {
      renderImpl = await makeRenderer();
    } catch {
      renderImpl = null;
    }
  }

  const gameContext = discoveryGameContext();
  const usedSeeds = [];
  let seeds = baseSeeds.length ? baseSeeds : discoverySeeds([]);
  usedSeeds.push(...seeds);
  let expandCount = DISCOVERY_EXPAND_COUNT;
  let sessionFound = 0;
  let lastProgress = "";

  // Mark running in the persisted state.
  {
    const data = await readData();
    data.discoveryState = {
      ...data.discoveryState,
      running: true,
      lastStatus: "running",
      startedAt: nowIso(),
      endsAt: new Date(overallDeadline).toISOString(),
      sessionFound: 0,
      progress: "세션 시작",
      trigger,
      lastMessage: "세션 시작",
    };
    await writeData(data);
  }

  let status = "ok";
  try {
    while (Date.now() < overallDeadline && !discoveryStop) {
      const chunkDeadline = Math.min(overallDeadline, Date.now() + DISCOVERY_CHUNK_MS);
      const data = await readData();
      const result = await runDiscovery(seeds, {
        config: { ...discoveryConfigForServer(data), renderImpl },
        gameContext,
        knownProfiles: data.creatorProfiles || [],
        perSeed,
        minFitScore,
        expandCount,
        leadDepth: DISCOVERY_LEAD_DEPTH,
        deadline: chunkDeadline,
        onProgress: (m) => {
          lastProgress = m;
        },
      });
      mergeDiscoveryCandidates(data, result.candidates);
      sessionFound += result.stats.newCreators;
      data.discoveryState = {
        ...data.discoveryState,
        running: true,
        lastStatus: "running",
        lastRunAt: nowIso(),
        lastStats: result.stats,
        sessionFound,
        progress: lastProgress,
        lastMessage: `세션 진행 — 누적 신규 ${sessionFound} · 검색 ${result.stats.seedsSearched}`,
      };
      await writeData(data);

      if (discoveryStop || Date.now() >= overallDeadline) break;

      // Queue drained → ask gemma for a fresh batch to keep the window busy.
      let next = [];
      try {
        next = await expandSeeds({ gameContext: gameContext || "", existingSeeds: usedSeeds.slice(-25), count: 8 });
      } catch {
        next = [];
      }
      next = next.filter((q) => !usedSeeds.some((u) => u.toLowerCase() === q.toLowerCase()));
      if (!next.length) {
        status = "dry"; // nothing new to search — stop early
        break;
      }
      usedSeeds.push(...next);
      seeds = next;
      expandCount = 0; // already expanded; fresh batch is the new base
    }
  } catch (error) {
    status = "error";
    console.error("Discovery session failed:", error.message || error);
  } finally {
    if (renderImpl) await closeRenderer();
    discoveryRunning = false;
    const data = await readData();
    const finalStatus = discoveryStop ? "stopped" : status === "dry" ? "ok" : status;
    data.discoveryState = {
      ...data.discoveryState,
      running: false,
      lastStatus: finalStatus,
      endsAt: "",
      progress: "",
      lastMessage: `세션 종료 (${finalStatus}) — 누적 신규 ${sessionFound}`,
    };
    await writeData(data);
    console.log(`[discovery] session ${finalStatus} — new creators: ${sessionFound}`);
  }
  return { started: true };
}

// Nightly window scheduler: checks periodically and, while inside the window,
// runs a session whose deadline is the window's end. The runtime `running`
// guard prevents overlap, so it simply keeps the bot busy from start to end.
async function checkScheduledDiscovery() {
  if (discoveryRunning) return;
  const win = discoveryWindow();
  const now = new Date();
  const minOfDay = now.getHours() * 60 + now.getMinutes();
  if (!inWindow(minOfDay, win)) return;

  // Deadline = next occurrence of the window-end time.
  const end = new Date(now);
  end.setHours(Math.floor(win.endMin / 60), win.endMin % 60, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);

  runDiscoverySession({ overallDeadline: end.getTime(), trigger: "schedule" }).catch((error) =>
    console.error("Scheduled discovery failed:", error.message || error),
  );
}

// Routes reachable without a Microsoft login. `/api/auth/config` bootstraps the
// browser login; the YouTube OAuth routes are full-page browser redirects that
// cannot carry a bearer token (and are self-protected by Google OAuth + state).
const PUBLIC_API_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/config",
  "GET /api/youtube/oauth/start",
  "GET /api/youtube/oauth/callback",
]);

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // Public: the browser needs this before it can log in.
  if (route === "GET /api/auth/config") {
    return respondJson(res, 200, getPublicAuthConfig());
  }

  // Microsoft login gate. When enabled, every /api/* call (except the small
  // public set above) must carry a valid company ID token for an allow-listed
  // executive — otherwise the sensitive data is never served, even to curl.
  if (authEnabled && !PUBLIC_API_ROUTES.has(route)) {
    try {
      req.authUser = await authenticateRequest(req);
    } catch (error) {
      const statusCode = error instanceof AuthError ? error.statusCode : 401;
      const code = error instanceof AuthError ? error.code : "unauthorized";
      res.setHeader("WWW-Authenticate", "Bearer");
      return respondError(res, statusCode, error.message || "Unauthorized", { code });
    }
  }

  // Who am I? Lets the client choose between login / access-denied / ready.
  if (route === "GET /api/auth/me") {
    return respondJson(res, 200, { email: req.authUser?.email ?? null, enabled: authEnabled });
  }

  const data = await readData();

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
    return respondJson(res, 200, buildDashboard(data, requestedGameId(url), url.searchParams.get("clientDate") || ""));
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
        clientSecretMasked: data.integrationSettings.youtubeClientSecretMasked || "",
        redirectUri: youtubeOAuthRedirectUri(url),
      },
      autoSyncAt: data.integrationSettings.youtubeAutoSyncAt || 0,
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

  const profileRoute = url.pathname.match(/^\/api\/creator-profiles\/([^/]+)$/);
  if (profileRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const id = decodeURIComponent(profileRoute[1]);
    const profile = data.creatorProfiles.find((p) => p.id === id);
    if (!profile) return respondError(res, 404, "프로필을 찾지 못했습니다.");
    const input = await readJson(req);
    if (input.channelName !== undefined) profile.channelName = String(input.channelName).trim() || profile.channelName;
    if (input.email !== undefined) profile.email = String(input.email).trim();
    if (input.country !== undefined) profile.country = String(input.country).trim();
    if (input.tags !== undefined) profile.tags = toList(input.tags);
    if (input.note !== undefined) profile.note = String(input.note);
    if (input.subscribers !== undefined) profile.subscribers = toNumber(input.subscribers);
    if (input.averageViews !== undefined) profile.averageViews = toNumber(input.averageViews);
    if (input.fitScore !== undefined) profile.fitScore = Math.max(0, Math.min(100, toNumber(input.fitScore)));
    if (input.status !== undefined) profile.status = String(input.status).trim() || profile.status;
    // Replace channel list when any channel input is supplied.
    if (input.channels !== undefined || input.links !== undefined || input.channelUrl !== undefined || input.channelUrls !== undefined || input.url !== undefined) {
      profile.channels = channelsFromInput(input);
    }
    profile.updatedAt = nowIso();
    normalizeCreatorProfile(profile);
    await writeData(data);
    return respondJson(res, 200, { ...profile, stats: creatorProfileStats(data, profile) });
  }
  if (profileRoute && req.method === "DELETE") {
    const id = decodeURIComponent(profileRoute[1]);
    const index = data.creatorProfiles.findIndex((p) => p.id === id);
    if (index < 0) return respondError(res, 404, "프로필을 찾지 못했습니다.");
    data.creatorProfiles.splice(index, 1);
    await writeData(data);
    return respondJson(res, 200, { deleted: id });
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

  if (route === "POST /api/import/key-csv/preview") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    let preview;
    try {
      preview = previewKeyCsv(data, gameId, input.csvText);
    } catch (error) {
      return respondError(res, 400, error.message || "Key CSV preview failed.");
    }
    return respondJson(res, 200, preview);
  }

  if (route === "POST /api/import/key-csv") {
    const input = await readJson(req);
    if (!input.csvText) return respondError(res, 400, "csvText is required.");
    const gameId = resolveGameId(data, input, data.meta.primaryGameId || DEFAULT_GAME_ID);
    const gameError = requireGame(data, gameId);
    if (gameError) return respondError(res, 400, gameError);
    let result;
    try {
      result = importKeyCsv(data, gameId, input.csvText);
    } catch (error) {
      return respondError(res, 400, error.message || "Key CSV import failed.");
    }
    await writeData(data);
    return respondJson(res, 201, result);
  }

  if (route === "GET /api/creators") {
    const gameId = requestedGameId(url);
    return respondJson(
      res,
      200,
      scopedItems(data.creators, gameId)
        .map((creator) => ({
          ...sanitizeCreator(creator),
          // Operators need the actual code to send it; return the decrypted value to the
          // authenticated client (kept encrypted at rest; never included in exports).
          steamKey: decryptSecret(creator.steamKeyEncrypted),
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
    // Profile-only fields — never pass the engagement status, which would clobber the shared
    // profile's own "active" status with a per-game lifecycle value.
    const profile = upsertCreatorProfile(data, {
      creatorProfileId: input.creatorProfileId || "",
      channelName,
      platform,
      handle: input.handle || creatorSlug,
      email: input.email || "",
      country: input.country || "",
      tags: input.tags || input.niche,
      subscribers: input.subscribers || input.followers,
      averageViews: input.averageViews,
      fitScore: input.fitScore,
      note: input.note,
    });
    const rawSteamKey = input.steamKey || input.key || input.code || input.value || "";
    const status = normalizeCreatorStatus(input.status, "uncontacted");
    const creator = {
      id: input.id || makeId("creator", channelName),
      creatorProfileId: profile.id,
      gameId,
      channelName: profile.channelName || channelName,
      handle: input.handle || profile.handle || creatorSlug,
      platform,
      recipientType: normalizeRecipientType(input.recipientType || platform),
      email: input.email || profile.email || "",
      country: input.country || profile.country || "",
      channelUrl: String(input.channelUrl || input.url || "").trim(),
      tags: toList(input.tags || input.niche || profile.tags),
      subscribers: toNumber(input.subscribers || input.followers || profile.subscribers),
      averageViews: toNumber(input.averageViews || profile.averageViews),
      fitScore: Math.max(0, Math.min(100, toNumber(input.fitScore || profile.fitScore))),
      status,
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
      sentAt: input.sentAt || (["sent", "review"].includes(status) ? toDateString(new Date()) : ""),
      embargoAt: input.embargoAt || "",
      steamKeyEncrypted: rawSteamKey ? encryptSteamKey(rawSteamKey) : "",
      steamKeyMasked: rawSteamKey ? maskSteamKey(rawSteamKey) : "",
      steamActivation: null,
      countedAsSent: false,
      note: input.note || "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    // Optional manual "used / unused" override at creation time.
    if (input.activated !== undefined) {
      creator.steamActivation = {
        activated: input.activated === true || input.activated === "true",
        account: String(input.activationAccount || "").trim(),
        checkedAt: nowIso(),
        source: "manual",
      };
    }
    data.creators.push(creator);
    applyCreatorKeySideEffects(data, creator);
    await writeData(data);
    return respondJson(res, 201, sanitizeCreator(creator));
  }

  const creatorRoute = url.pathname.match(/^\/api\/creators\/([^/]+)$/);
  if (creatorRoute && req.method === "DELETE") {
    const creatorId = decodeURIComponent(creatorRoute[1]);
    const index = data.creators.findIndex((item) => item.id === creatorId);
    if (index < 0) return respondError(res, 404, "크리에이터를 찾지 못했습니다.");
    data.creators.splice(index, 1);
    await writeData(data);
    return respondJson(res, 200, { deleted: creatorId });
  }
  if (creatorRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const creatorId = decodeURIComponent(creatorRoute[1]);
    const creator = data.creators.find((item) => item.id === creatorId);
    if (!creator) return respondError(res, 404, "크리에이터를 찾지 못했습니다.");
    const input = await readJson(req);
    if (input.channelName !== undefined) creator.channelName = String(input.channelName).trim() || creator.channelName;
    if (input.email !== undefined) creator.email = String(input.email).trim();
    if (input.recipientType !== undefined) creator.recipientType = normalizeRecipientType(input.recipientType);
    if (input.country !== undefined) creator.country = String(input.country).trim();
    if (input.channelUrl !== undefined) creator.channelUrl = String(input.channelUrl).trim();
    if (input.tags !== undefined) creator.tags = toList(input.tags);
    if (input.fitScore !== undefined) creator.fitScore = Math.max(0, Math.min(100, toNumber(input.fitScore)));
    if (input.sentAt !== undefined) creator.sentAt = String(input.sentAt).trim();
    if (input.embargoAt !== undefined) creator.embargoAt = String(input.embargoAt).trim();
    if (input.note !== undefined) creator.note = String(input.note);
    if (input.utmLink !== undefined) creator.utmLink = String(input.utmLink).trim();
    if (input.campaignId !== undefined) creator.campaignId = String(input.campaignId).trim();
    // When a key field is explicitly provided (even as empty), set it — empty clears the key.
    if (input.steamKey !== undefined || input.key !== undefined || input.code !== undefined || input.value !== undefined) {
      const rawSteamKey = String(input.steamKey || input.key || input.code || input.value || "").trim();
      creator.steamKeyEncrypted = rawSteamKey ? encryptSteamKey(rawSteamKey) : "";
      creator.steamKeyMasked = rawSteamKey ? maskSteamKey(rawSteamKey) : "";
      creator.steamActivation = null;
    }
    if (input.status !== undefined) {
      creator.status = normalizeCreatorStatus(input.status, creator.status);
      if (creator.status === "sent" && !creator.sentAt) creator.sentAt = toDateString(new Date());
      applyCreatorKeySideEffects(data, creator);
    }
    // Manual override of the Steam "used / unused" flag without a live query.
    if (input.activated !== undefined) {
      creator.steamActivation = {
        activated: input.activated === true || input.activated === "true",
        account: String(input.activationAccount || "").trim(),
        checkedAt: nowIso(),
        source: "manual",
      };
    }
    creator.updatedAt = nowIso();
    await writeData(data);
    return respondJson(res, 200, sanitizeCreator(creator));
  }

  if (route === "POST /api/creators/check-activation") {
    const input = await readJson(req);
    const gameId = requestedGameId(url) || input.gameId || "all";
    const targets = scopedItems(data.creators, gameId).filter((creator) => decryptSecret(creator.steamKeyEncrypted));
    const summary = await checkActivationForCreators(data, targets);
    await writeData(data);
    return respondJson(res, 200, summary);
  }

  const creatorActivationRoute = url.pathname.match(/^\/api\/creators\/([^/]+)\/check-activation$/);
  if (creatorActivationRoute && req.method === "POST") {
    const creatorId = decodeURIComponent(creatorActivationRoute[1]);
    const creator = data.creators.find((item) => item.id === creatorId);
    if (!creator) return respondError(res, 404, "크리에이터를 찾지 못했습니다.");
    const summary = await checkActivationForCreators(data, [creator]);
    await writeData(data);
    if (summary.authError) return respondError(res, 502, summary.message);
    if (summary.error) return respondError(res, 400, summary.message);
    return respondJson(res, 200, { ...sanitizeCreator(creator), checked: summary.checked });
  }

  if (route === "POST /api/email-drafts") {
    const input = await readJson(req);
    let draft;
    try {
      draft = await buildEmailDraft(data, input);
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

  if (route === "GET /api/email-templates") {
    return respondJson(res, 200, data.emailTemplates);
  }
  if (route === "GET /api/ai/status") {
    return respondJson(res, 200, aiConfig());
  }

  // --- Creator discovery bot ---
  if (route === "GET /api/discovery") {
    const win = discoveryWindow();
    return respondJson(res, 200, {
      candidates: data.discoveryCandidates,
      // `running` from the live flag, not the persisted value (survives crashes).
      state: { ...data.discoveryState, running: discoveryRunning },
      sources: discoverySourceFlags(data),
      seeds: discoverySeeds([]),
      schedulerEnabled: !DISABLE_DISCOVERY_SCHEDULER,
      window: { start: process.env.DISCOVERY_WINDOW_START || "02:00", end: process.env.DISCOVERY_WINDOW_END || "09:00", ...win },
      rendererEnabled: discoveryUseRenderer(),
      sessionMinuteChoices: [30, 60, 120, 180],
    });
  }
  if (route === "POST /api/discovery/run") {
    const input = await readJson(req);
    const seeds = Array.isArray(input.seeds) ? input.seeds.map((s) => String(s).trim()).filter(Boolean) : toList(input.seeds);
    const flags = discoverySourceFlags(data);
    if (!flags.youtube && !flags.twitch && !flags.web) {
      return respondError(res, 400, "검색 소스가 하나도 설정되지 않았습니다. YouTube 키 또는 Twitch/웹검색 키를 먼저 설정하세요.");
    }
    if (discoveryRunning) return respondError(res, 409, "이미 발견 세션이 실행 중입니다.");

    const perSeed = Math.max(1, Math.min(25, toNumber(input.perSeed, 8)));
    const minFitScore = Math.max(0, Math.min(100, toNumber(input.minFitScore, 0)));
    const durationMinutes = clampSessionMinutes(input.durationMinutes);

    // Time-boxed (30m/1h/2h/3h) → run in the BACKGROUND and return immediately;
    // the client polls GET /api/discovery for progress + candidates.
    if (durationMinutes > 0) {
      const overallDeadline = Date.now() + durationMinutes * 60_000;
      runDiscoverySession({ baseSeeds: seeds, overallDeadline, perSeed, minFitScore, trigger: "manual" }).catch((error) =>
        console.error("Discovery session failed:", error.message || error),
      );
      return respondJson(res, 202, { started: true, durationMinutes, endsAt: new Date(overallDeadline).toISOString() });
    }

    // No duration → a single short, awaited "quick run".
    try {
      const result = await runDiscoveryQuick(data, {
        seeds,
        perSeed,
        minFitScore,
        expandCount: Math.max(0, Math.min(20, toNumber(input.expandSeeds, 0))),
        leadDepth: Math.max(0, Math.min(3, toNumber(input.leadDepth, 0))),
        analyze: input.analyze !== false,
      });
      await writeData(data);
      return respondJson(res, 200, {
        stats: result.stats,
        skipped: result.skipped,
        errors: result.errors,
        candidates: data.discoveryCandidates,
        state: data.discoveryState,
      });
    } catch (error) {
      data.discoveryState = { ...data.discoveryState, lastRunAt: nowIso(), lastStatus: "error", lastMessage: error.message || "실패" };
      await writeData(data);
      return respondError(res, 502, error.message || "발견 실행에 실패했습니다.", aiConfig());
    }
  }
  if (route === "POST /api/discovery/stop") {
    if (!discoveryRunning) return respondJson(res, 200, { ok: true, running: false });
    discoveryStop = true;
    return respondJson(res, 200, { ok: true, stopping: true });
  }
  const discoveryApproveRoute = url.pathname.match(/^\/api\/discovery\/candidates\/([^/]+)\/approve$/);
  if (discoveryApproveRoute && req.method === "POST") {
    const id = decodeURIComponent(discoveryApproveRoute[1]);
    const candidate = data.discoveryCandidates.find((c) => c.id === id);
    if (!candidate) return respondError(res, 404, "후보를 찾지 못했습니다.");
    const profile = upsertCreatorProfile(data, {
      channelName: candidate.channelName,
      platform: candidate.platform,
      email: candidate.email,
      channels: candidate.url ? [{ platform: candidate.platform, url: candidate.url }] : [],
      subscribers: candidate.subscribers,
      fitScore: candidate.fitScore,
      tags: candidate.tags,
      note: [candidate.channelType, candidate.audience, candidate.fitReason].filter(Boolean).join(" · "),
    });
    candidate.status = "approved";
    candidate.creatorProfileId = profile.id;
    candidate.updatedAt = nowIso();
    await writeData(data);
    return respondJson(res, 200, { ok: true, candidate, profile });
  }
  const discoveryCandidateRoute = url.pathname.match(/^\/api\/discovery\/candidates\/([^/]+)$/);
  if (discoveryCandidateRoute && req.method === "DELETE") {
    const id = decodeURIComponent(discoveryCandidateRoute[1]);
    const candidate = data.discoveryCandidates.find((c) => c.id === id);
    if (!candidate) return respondError(res, 404, "후보를 찾지 못했습니다.");
    candidate.status = "dismissed";
    candidate.updatedAt = nowIso();
    await writeData(data);
    return respondJson(res, 200, { ok: true, id });
  }
  if (route === "POST /api/ai/translate") {
    const input = await readJson(req);
    const text = String(input.text || "").trim();
    if (!text) return respondError(res, 400, "번역할 텍스트가 필요합니다.");
    const targetLang = SUPPORTED_LANGS.includes(input.targetLang) ? input.targetLang : "ko";
    try {
      const translated = await translateText({ text, targetLang });
      return respondJson(res, 200, { text: translated });
    } catch (error) {
      return respondError(res, 502, error.message || "번역에 실패했습니다.", aiConfig());
    }
  }
  if (route === "POST /api/email-templates/generate") {
    const input = await readJson(req);
    const brief = String(input.brief || "").trim();
    if (!brief) return respondError(res, 400, "생성할 템플릿 설명(브리프)이 필요합니다.");
    const game = input.gameId ? gameFor(data, input.gameId) : gameFor(data, data.meta.primaryGameId);
    try {
      const draft = await generateEmailTemplate({
        brief,
        gameName: input.gameName || game?.name || "",
        genre: input.genre || game?.genre || "",
      });
      return respondJson(res, 200, draft);
    } catch (error) {
      return respondError(res, 502, error.message || "AI 생성에 실패했습니다.", aiConfig());
    }
  }
  if (route === "POST /api/email-templates") {
    const input = await readJson(req);
    const name = String(input.name || "").trim();
    if (!name) return respondError(res, 400, "템플릿 이름이 필요합니다.");
    const tmpl = {
      id: input.id || makeId("tmpl", name),
      name,
      subjectEn: String(input.subjectEn || "").trim(),
      bodyEn: String(input.bodyEn || ""),
      subjectKo: String(input.subjectKo || "").trim(),
      bodyKo: String(input.bodyKo || ""),
      subjectJa: String(input.subjectJa || "").trim(),
      bodyJa: String(input.bodyJa || ""),
      subjectDe: String(input.subjectDe || "").trim(),
      bodyDe: String(input.bodyDe || ""),
      subjectZh: String(input.subjectZh || "").trim(),
      bodyZh: String(input.bodyZh || ""),
      builtin: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.emailTemplates.push(tmpl);
    await writeData(data);
    return respondJson(res, 201, tmpl);
  }
  const templateRoute = url.pathname.match(/^\/api\/email-templates\/([^/]+)$/);
  if (templateRoute && (req.method === "PUT" || req.method === "PATCH")) {
    const id = decodeURIComponent(templateRoute[1]);
    const tmpl = data.emailTemplates.find((item) => item.id === id);
    if (!tmpl) return respondError(res, 404, "템플릿을 찾지 못했습니다.");
    const input = await readJson(req);
    if (input.name !== undefined) tmpl.name = String(input.name).trim() || tmpl.name;
    if (input.subjectEn !== undefined) tmpl.subjectEn = String(input.subjectEn);
    if (input.bodyEn !== undefined) tmpl.bodyEn = String(input.bodyEn);
    if (input.subjectKo !== undefined) tmpl.subjectKo = String(input.subjectKo);
    if (input.bodyKo !== undefined) tmpl.bodyKo = String(input.bodyKo);
    if (input.subjectJa !== undefined) tmpl.subjectJa = String(input.subjectJa);
    if (input.bodyJa !== undefined) tmpl.bodyJa = String(input.bodyJa);
    if (input.subjectDe !== undefined) tmpl.subjectDe = String(input.subjectDe);
    if (input.bodyDe !== undefined) tmpl.bodyDe = String(input.bodyDe);
    if (input.subjectZh !== undefined) tmpl.subjectZh = String(input.subjectZh);
    if (input.bodyZh !== undefined) tmpl.bodyZh = String(input.bodyZh);
    tmpl.updatedAt = nowIso();
    await writeData(data);
    return respondJson(res, 200, tmpl);
  }
  if (templateRoute && req.method === "DELETE") {
    const id = decodeURIComponent(templateRoute[1]);
    const index = data.emailTemplates.findIndex((item) => item.id === id);
    if (index < 0) return respondError(res, 404, "템플릿을 찾지 못했습니다.");
    data.emailTemplates.splice(index, 1);
    await writeData(data);
    return respondJson(res, 200, { deleted: id });
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
    const ext = path.extname(filePath);
    const contentType = contentTypes.get(ext) || "application/octet-stream";
    let body = await readFile(filePath);
    if (ext === ".html") {
      body = Buffer.from(body.toString("utf8").replaceAll("__ASSET_VERSION__", ASSET_VERSION), "utf8");
    }
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
  const auth = authConfigSummary();
  if (auth.enabled) {
    const scope =
      [
        auth.allowedDomains.length ? `domain(s) ${auth.allowedDomains.join(", ")}` : null,
        auth.allowedCount ? `${auth.allowedCount} email(s)` : null,
      ]
        .filter(Boolean)
        .join(" + ") || "none";
    console.log(`[auth] Microsoft login ENFORCED · tenant ${auth.tenantId} · allow ${scope}`);
  } else {
    console.warn("[auth] Microsoft login DISABLED — /api/* is open. Set MS_CLIENT_ID + AUTH_ALLOWED_EMAILS (or AUTH_ENABLED=true) to lock it down.");
  }
});

if (!DISABLE_SYNC_SCHEDULER) {
  setInterval(checkScheduledSync, Math.max(10_000, SYNC_SCHEDULER_INTERVAL_MS));
}

// Discovery bot loop: checks every few minutes and, while inside the nightly
// window (DISCOVERY_WINDOW_START–END, default 02:00–09:00), runs a session until
// the window closes. Off unless DISABLE_DISCOVERY_SCHEDULER=false.
if (!DISABLE_DISCOVERY_SCHEDULER) {
  setInterval(checkScheduledDiscovery, 5 * 60 * 1000);
  checkScheduledDiscovery().catch(() => {}); // also check right away on boot
}
