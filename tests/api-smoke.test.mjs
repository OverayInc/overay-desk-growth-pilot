import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const BASE_URL = (process.env.TEST_BASE_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
const RUN_ID = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function preview(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function assertObject(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} should be a JSON object. Got: ${preview(value)}`);
}

function assertArray(value, label) {
  assert(Array.isArray(value), `${label} should be a JSON array. Got: ${preview(value)}`);
}

function containsDeep(value, expected) {
  return JSON.stringify(value).toLowerCase().includes(String(expected).toLowerCase());
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  const init = { method, headers };

  if (Object.hasOwn(options, 'body')) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch (error) {
    fail(`${method} ${path} failed before receiving a response. Is the server running at ${BASE_URL}? ${error.message}`);
  }

  const body = await parseResponse(response);
  return { response, body, method, path };
}

function assertOk(result) {
  assert(
    result.response.ok,
    `${result.method} ${result.path} expected a 2xx response, got ${result.response.status}. Body: ${preview(result.body)}`,
  );
}

async function requestOk(path, options) {
  const result = await request(path, options);
  assertOk(result);
  return result.body;
}

test('serves the static dashboard UI', async () => {
  const result = await request('/', { headers: { Accept: 'text/html,application/xhtml+xml' } });
  assertOk(result);

  const contentType = result.response.headers.get('content-type') || '';
  assert(contentType.includes('text/html'), `GET / should return HTML. Content-Type: ${contentType}`);
  assert(typeof result.body === 'string', `GET / should return an HTML string. Got: ${preview(result.body)}`);
  assert(/<!doctype html|<html[\s>]/i.test(result.body), 'GET / should include an HTML document marker.');
});

test('reports API health', async () => {
  const body = await requestOk('/api/health');
  assertObject(body, 'GET /api/health');
  assert(body.ok === true, `GET /api/health should return { ok: true }. Got: ${preview(body)}`);
});

test('returns dashboard and list resources', async () => {
  const dashboard = await requestOk('/api/dashboard');
  assertObject(dashboard, 'GET /api/dashboard');
  assertArray(dashboard.portfolio, 'GET /api/dashboard portfolio');

  for (const path of ['/api/games', '/api/creator-profiles', '/api/creators', '/api/campaigns', '/api/keys', '/api/steam-metrics', '/api/outreach-logs']) {
    const body = await requestOk(path);
    assertArray(body, `GET ${path}`);
  }

  const syncStatus = await requestOk('/api/steam-sync/status');
  assertObject(syncStatus, 'GET /api/steam-sync/status');

  const syncSchedule = await requestOk('/api/sync-schedule');
  assertObject(syncSchedule, 'GET /api/sync-schedule');

  const settings = await requestOk('/api/settings');
  assertObject(settings, 'GET /api/settings');

  const emailStatus = await requestOk('/api/email/status');
  assertObject(emailStatus, 'GET /api/email/status');

  const readiness = await requestOk('/api/readiness');
  assertObject(readiness, 'GET /api/readiness');
  assertObject(readiness.summary, 'GET /api/readiness summary');
});

test('manages integration settings without exposing secrets', async () => {
  const steamSecret = `steam-secret-${RUN_ID}`;
  const smtpSecret = `smtp-secret-${RUN_ID}`;
  const settings = await requestOk('/api/settings', {
    method: 'PUT',
    body: {
      steamFinancialApiKey: steamSecret,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUser: `mailer-${RUN_ID}@example.com`,
      smtpPass: smtpSecret,
      smtpSecure: false,
      smtpStarttls: true,
      emailFrom: `mailer-${RUN_ID}@example.com`,
      emailReplyTo: `reply-${RUN_ID}@example.com`,
      emailSendMode: 'log',
    },
  });
  assertObject(settings, 'PUT /api/settings');
  assert(settings.steam?.configured === true, `Stored Steam key should be configured. Got: ${preview(settings)}`);
  assert(settings.steam?.source === 'web', `Stored Steam key should use web source. Got: ${preview(settings)}`);
  assert(settings.email?.configured === true, `Stored email settings should be configured. Got: ${preview(settings)}`);
  assert(settings.email?.source === 'web', `Stored email settings should use web source. Got: ${preview(settings)}`);
  assert(!containsDeep(settings, steamSecret), 'Settings response should not expose the raw Steam API key.');
  assert(!containsDeep(settings, smtpSecret), 'Settings response should not expose the raw SMTP password.');

  const publicSettings = await requestOk('/api/settings');
  assertObject(publicSettings, 'GET /api/settings after update');
  assert(!containsDeep(publicSettings, steamSecret), 'Public settings should not expose the raw Steam API key.');
  assert(!containsDeep(publicSettings, smtpSecret), 'Public settings should not expose the raw SMTP password.');
  assert(containsDeep(publicSettings, 'steam-secret') === false, 'Public settings should expose only masked key material.');

  const syncStatus = await requestOk('/api/steam-sync/status');
  assert(syncStatus.configured === true, `Steam sync should read web-managed API key. Got: ${preview(syncStatus)}`);
  assert(syncStatus.keyEnv === 'web', `Steam sync status should report the web key source. Got: ${preview(syncStatus)}`);
  assert(!containsDeep(syncStatus, steamSecret), 'Steam sync status should not expose the raw Steam API key.');

  const emailStatus = await requestOk('/api/email/status');
  assert(emailStatus.configured === true, `Email status should read web-managed SMTP settings. Got: ${preview(emailStatus)}`);
  assert(emailStatus.mode === 'log', `Email send mode should be saved from settings. Got: ${preview(emailStatus)}`);
  assert(emailStatus.source === 'web', `Email status should report the web settings source. Got: ${preview(emailStatus)}`);
  assert(!containsDeep(emailStatus, smtpSecret), 'Email status should not expose the raw SMTP password.');
});

test('manages shared creator profiles independently from games', async () => {
  const profilePayload = {
    channelName: `QA Shared Creator ${RUN_ID}`,
    handle: `shared_${RUN_ID}`,
    platform: 'YouTube',
    email: `shared+${RUN_ID}@example.com`,
    tags: 'anomaly, indie horror',
    averageViews: 24000,
    fitScore: 88,
  };

  const profile = await requestOk('/api/creator-profiles', {
    method: 'POST',
    body: profilePayload,
  });
  assertObject(profile, 'POST /api/creator-profiles');
  assert(profile.id, 'POST /api/creator-profiles should return a profile id.');

  const profiles = await requestOk('/api/creator-profiles');
  assertArray(profiles, 'GET /api/creator-profiles after create');
  assert(containsDeep(profiles, profilePayload.channelName), 'Created shared creator profile should be visible.');
});

test('imports shared creator profiles from CSV', async () => {
  const csvText = [
    'channelName,platform,email,country,tags,averageViews,fitScore',
    `QA CSV Creator ${RUN_ID},YouTube,csv+${RUN_ID}@example.com,US,"anomaly, horror",31000,91`,
    `QA CSV Creator 2 ${RUN_ID},TikTok,csv2+${RUN_ID}@example.com,KR,"shorts, indie",12000,74`,
  ].join('\n');

  const previewBody = await requestOk('/api/import/creator-csv/preview', {
    method: 'POST',
    body: { csvText },
  });
  assertObject(previewBody, 'POST /api/import/creator-csv/preview');
  assert(previewBody.totalRows === 2, `Creator CSV preview should count 2 rows. Got: ${preview(previewBody)}`);
  assertArray(previewBody.previewRows, 'Creator CSV preview rows');

  const importBody = await requestOk('/api/import/creator-csv', {
    method: 'POST',
    body: { csvText },
  });
  assertObject(importBody, 'POST /api/import/creator-csv');
  assert(importBody.imported === 2, `Creator CSV import should create 2 profiles. Got: ${preview(importBody)}`);

  const profiles = await requestOk('/api/creator-profiles');
  assert(containsDeep(profiles, `QA CSV Creator ${RUN_ID}`), 'Imported creator profile should be visible.');
});

test('creates growth records and exposes them through list APIs', async () => {
  const gamePayload = {
    name: `QA Game ${RUN_ID}`,
    steamAppId: '123456',
    stage: 'prototype',
    genre: 'QA anomaly',
  };

  const game = await requestOk('/api/games', {
    method: 'POST',
    body: gamePayload,
  });
  assertObject(game, 'POST /api/games');
  assert(game.id, 'POST /api/games should return a game id.');

  const updatedGame = await requestOk(`/api/games/${encodeURIComponent(game.id)}`, {
    method: 'PUT',
    body: {
      ...gamePayload,
      name: `${gamePayload.name} Updated`,
      steamStoreUrl: 'https://store.steampowered.com/app/123456/QA_Game/',
      launchDate: '2026-07-01',
      owner: 'QA',
    },
  });
  assertObject(updatedGame, 'PUT /api/games/:id');
  assert(updatedGame.name.endsWith('Updated'), 'PUT /api/games/:id should update the game name.');
  assert(containsDeep(updatedGame, 'QA_Game'), 'PUT /api/games/:id should update Steam Store URL.');

  const creatorPayload = {
    gameId: game.id,
    name: `QA Creator ${RUN_ID}`,
    handle: `qa_${RUN_ID}`,
    platform: 'YouTube',
    followers: 12500,
    niche: 'strategy',
    email: `qa+${RUN_ID}@example.com`,
    status: 'active',
  };

  const creator = await requestOk('/api/creators', {
    method: 'POST',
    body: creatorPayload,
  });
  assertObject(creator, 'POST /api/creators');
  assert(creator.creatorProfileId, 'POST /api/creators should link to a shared creator profile.');

  const creators = await requestOk('/api/creators');
  assertArray(creators, 'GET /api/creators after create');
  assert(containsDeep(creators, creatorPayload.name) || containsDeep(creators, creatorPayload.handle), 'Created creator should be visible in GET /api/creators.');

  const profiles = await requestOk('/api/creator-profiles');
  assertArray(profiles, 'GET /api/creator-profiles after creator create');
  assert(containsDeep(profiles, creatorPayload.name) || containsDeep(profiles, creatorPayload.handle), 'Game outreach creator should be stored in the shared creator DB.');

  const campaignPayload = {
    gameId: game.id,
    name: `QA Campaign ${RUN_ID}`,
    goal: 'Wishlist conversion',
    budget: 5000,
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    status: 'planned',
  };

  const campaign = await requestOk('/api/campaigns', {
    method: 'POST',
    body: campaignPayload,
  });
  assertObject(campaign, 'POST /api/campaigns');

  const campaigns = await requestOk('/api/campaigns');
  assertArray(campaigns, 'GET /api/campaigns after create');
  assert(containsDeep(campaigns, campaignPayload.name), 'Created campaign should be visible in GET /api/campaigns.');

  const draft = await requestOk('/api/email-drafts', {
    method: 'POST',
    body: {
      creatorId: creator.id,
      gameId: game.id,
      campaignId: campaign.id,
    },
  });
  assertObject(draft, 'POST /api/email-drafts');
  assert(containsDeep(draft, 'mailto:'), 'Email draft should include a mailto link.');
  assert(containsDeep(draft, gamePayload.name), 'Email draft should include the game name.');
  assert(containsDeep(draft, 'utm_source'), 'Email draft should include a tracked UTM link.');

  const sendResult = await requestOk('/api/email-send', {
    method: 'POST',
    body: { draft },
  });
  assertObject(sendResult, 'POST /api/email-send');
  assert(['blocked', 'logged', 'sent', 'failed'].includes(sendResult.status), `Email send should return an operational status. Got: ${preview(sendResult)}`);

  const outreachLogs = await requestOk('/api/outreach-logs');
  assertArray(outreachLogs, 'GET /api/outreach-logs after email send');
  assert(containsDeep(outreachLogs, draft.subject), 'Email send should create an outreach log.');

  const keyPayload = {
    gameId: game.id,
    key: `QA-${RUN_ID.toUpperCase()}-STEAM-001`,
    code: `QA-${RUN_ID.toUpperCase()}-STEAM-001`,
    value: `QA-${RUN_ID.toUpperCase()}-STEAM-001`,
    platform: 'Steam',
    status: 'available',
    creatorHandle: creatorPayload.handle,
    campaignName: campaignPayload.name,
    notes: 'Created by API smoke test',
  };

  const key = await requestOk('/api/keys', {
    method: 'POST',
    body: keyPayload,
  });
  assertObject(key, 'POST /api/keys');
  assert(!containsDeep(key, 'steamKeyEncrypted'), 'POST /api/keys should not expose encrypted Steam key material.');
  assert(containsDeep(key, 'steamKeyMasked'), 'POST /api/keys should return a masked Steam key.');

  const keys = await requestOk('/api/keys');
  assertArray(keys, 'GET /api/keys after create');
  assert(containsDeep(keys, key.steamKeyMasked), 'Created key should be visible in GET /api/keys as a masked key.');
  assert(!containsDeep(keys, 'steamKeyEncrypted'), 'GET /api/keys should not expose encrypted Steam key material.');
});

test('generates UTM links', async () => {
  const payload = {
    baseUrl: 'https://store.steampowered.com/app/123456/Launch_Pilot/',
    source: `qa_${RUN_ID}`,
    medium: 'creator',
    campaign: `QA Campaign ${RUN_ID}`,
    content: RUN_ID,
  };

  const body = await requestOk('/api/utm-links', {
    method: 'POST',
    body: payload,
  });

  assert(body && typeof body === 'object', `POST /api/utm-links should return a JSON value. Got: ${preview(body)}`);
  assert(containsDeep(body, 'utm_source'), 'UTM response should include utm_source.');
  assert(containsDeep(body, 'utm_medium'), 'UTM response should include utm_medium.');
  assert(containsDeep(body, 'utm_campaign'), 'UTM response should include utm_campaign.');
  assert(containsDeep(body, payload.source), 'UTM response should include the source value.');
});

test('imports Steam CSV metrics and exposes imported metrics', async () => {
  const csvText = await readFile(new URL('./fixtures/steam_metrics.csv', import.meta.url), 'utf8');
  const game = await requestOk('/api/games', {
    method: 'POST',
    body: {
      name: `QA CSV Game ${RUN_ID}`,
      steamAppId: '654321',
      stage: 'prototype',
      genre: 'QA import',
    },
  });

  const preview = await requestOk('/api/import/steam-csv/preview', {
    method: 'POST',
    body: { csvText, gameId: game.id },
  });
  assertObject(preview, 'POST /api/import/steam-csv/preview');
  assert(preview.totalRows === 3, `CSV preview should count 3 fixture rows. Got: ${preview.totalRows}`);
  assertArray(preview.previewRows, 'CSV preview rows');

  await requestOk('/api/import/steam-csv', {
    method: 'POST',
    body: { csvText, gameId: game.id },
  });

  const metrics = await requestOk('/api/steam-metrics');
  assertArray(metrics, 'GET /api/steam-metrics after CSV import');
  assert(containsDeep(metrics, '2026-05-01'), 'Imported Steam metrics should include fixture date 2026-05-01.');
  assert(containsDeep(metrics, 'wishlist'), 'Imported Steam metrics should preserve wishlist-related data.');
});

test('plans Steam API sync without exposing credentials', async () => {
  const game = await requestOk('/api/games', {
    method: 'POST',
    body: {
      name: `QA Sync Game ${RUN_ID}`,
      steamAppId: '123456',
      stage: 'prototype',
      genre: 'QA sync',
    },
  });

  const body = await requestOk('/api/steam-sync/run', {
    method: 'POST',
    body: {
      gameId: game.id,
      startDate: '2026-05-01',
      endDate: '2026-05-01',
      includeWishlist: true,
      includeSales: false,
      dryRun: true,
    },
  });

  assertObject(body, 'POST /api/steam-sync/run');
  assertObject(body.run, 'POST /api/steam-sync/run run');
  assert(['planned', 'blocked'].includes(body.run.status), `Steam sync dry run should be planned or blocked. Got: ${preview(body.run)}`);
  assert(!containsDeep(body, 'development-only-change-me'), 'Steam sync response should not expose secret values.');

  const runDetail = await requestOk(`/api/steam-sync/runs/${encodeURIComponent(body.run.id)}`);
  assertObject(runDetail, 'GET /api/steam-sync/runs/:id');
  assert(runDetail.id === body.run.id, 'Sync run detail should return the requested run.');
});

test('configures and triggers scheduled Steam sync safely', async () => {
  const game = await requestOk('/api/games', {
    method: 'POST',
    body: {
      name: `QA Scheduled Sync Game ${RUN_ID}`,
      steamAppId: '777777',
      stage: 'prototype',
      genre: 'QA schedule',
    },
  });

  const schedule = await requestOk('/api/sync-schedule', {
    method: 'PUT',
    body: {
      enabled: true,
      gameId: game.id,
      intervalHours: 24,
      lookbackDays: 1,
      startOffsetDays: 1,
      includeWishlist: true,
      includeSales: false,
    },
  });
  assertObject(schedule, 'PUT /api/sync-schedule');
  assert(schedule.enabled === true, 'Sync schedule should be enabled.');
  assert(schedule.gameId === game.id, 'Sync schedule should store selected game id.');

  const result = await requestOk('/api/sync-schedule/run-due', {
    method: 'POST',
    body: { force: true },
  });
  assertObject(result, 'POST /api/sync-schedule/run-due');
  assert(result.run || result.skipped === false, `Forced scheduled sync should produce a run. Got: ${preview(result)}`);
});

test('exports safe operational data without raw encrypted key material', async () => {
  const body = await requestOk('/api/export?type=all');
  assertObject(body, 'GET /api/export?type=all');
  assertArray(body.games, 'Export games');
  assertArray(body.creatorProfiles, 'Export creatorProfiles');
  assertArray(body.keys, 'Export keys');
  assert(!containsDeep(body, 'steamKeyEncrypted'), 'Safe export should not include encrypted Steam key material.');
  assert(!containsDeep(body, 'steam-secret'), 'Safe export should not include raw Steam API keys.');
  assert(!containsDeep(body, 'smtp-secret'), 'Safe export should not include raw SMTP passwords.');
});
