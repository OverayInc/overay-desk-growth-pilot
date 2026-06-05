// Discovery — standalone CLI runner.
//
// Exercises the whole pipeline without the web server:
//
//   node src/discovery/run.mjs "spot the anomaly game" "Exit 8 gameplay"
//   node src/discovery/run.mjs --dry "관찰 공포 게임"          # retrieval only (no gemma)
//   node src/discovery/run.mjs --expand 8 --leads 2 "이상현상 찾기"  # hybrid: gemma seeds + lead-following
//   node src/discovery/run.mjs --minutes 30 "spot the anomaly"  # time-boxed: run for 30 min
//   node src/discovery/run.mjs --render --minutes 60 "..."      # + Playwright email harvesting
//   node src/discovery/run.mjs --json "이상현상 찾기" > out.json
//
// Reads credentials from the environment (see .env.example). NEVER sends email —
// output is a list of "discovered" candidates for review.

import { runDiscovery } from "./pipeline.mjs";
import { discoveryConfigFromEnv, discoverySeeds, discoveryGameContext } from "./config.mjs";
import { makeRenderer, closeRenderer } from "./renderer.mjs";

function parseArgs(argv) {
  const flags = { dry: false, json: false, perSeed: 8, minFit: 0, expand: 0, leads: 0, render: false, minutes: 0 };
  const seeds = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") flags.dry = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--render") flags.render = true;
    else if (a === "--per-seed") flags.perSeed = Number(argv[++i]) || flags.perSeed;
    else if (a === "--min-fit") flags.minFit = Number(argv[++i]) || 0;
    else if (a === "--expand") flags.expand = Number(argv[++i]) || 0;
    else if (a === "--leads") flags.leads = Number(argv[++i]) || 0;
    else if (a === "--minutes") flags.minutes = Number(argv[++i]) || 0;
    else seeds.push(a);
  }
  return { flags, seeds };
}

async function main() {
  const { flags, seeds: argSeeds } = parseArgs(process.argv.slice(2));
  const seeds = discoverySeeds(argSeeds);
  const config = discoveryConfigFromEnv();

  let renderImpl = null;
  if (flags.render && !flags.dry) {
    renderImpl = await makeRenderer();
    if (!renderImpl && !flags.json) console.error("⚠ Playwright 미설치 — 평문 fetch로 진행 (npm i -D playwright)\n");
  }

  if (!flags.json) {
    console.error(`▶ 시드 ${seeds.length}개: ${seeds.join(", ")}`);
    console.error(`▶ 소스: youtube=${!!config.youtube.apiKey} twitch=${!!config.twitch.clientId} web=${config.web.provider || "off"}`);
    console.error(`▶ 모드: ${flags.dry ? "dry(검색만)" : "검색→크롤링→gemma"} · 확장 ${flags.expand} · 단서추적 ${flags.leads} · 렌더 ${!!renderImpl}${flags.minutes ? ` · ${flags.minutes}분 박스` : ""}\n`);
  }

  const result = await runDiscovery(seeds, {
    config: { ...config, renderImpl },
    gameContext: discoveryGameContext(),
    perSeed: flags.perSeed,
    minFitScore: flags.minFit,
    expandCount: flags.dry ? 0 : flags.expand,
    leadDepth: flags.dry ? 0 : flags.leads,
    analyze: !flags.dry,
    enrich: !flags.dry,
    deadline: flags.minutes ? Date.now() + flags.minutes * 60_000 : Infinity,
    onProgress: flags.json ? () => {} : (m) => console.error(`  · ${m}`),
  });

  if (renderImpl) await closeRenderer();

  const runAt = new Date().toISOString();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ runAt, ...result }, null, 2));
    return;
  }

  console.error("");
  if (result.skipped.length) console.error(`⚠ 건너뜀: ${result.skipped.join(" | ")}`);
  if (result.errors.length) console.error(`⚠ 오류: ${result.errors.slice(0, 5).join(" | ")}`);
  const s = result.stats;
  console.error(
    `\n✓ 검색 ${s.seedsSearched} · 발견 ${s.rawFound} · 분석 ${s.analyzed} · 채택 ${s.kept} (이메일 ${s.withEmail}, 신규 ${s.newCreators})${s.timedOut ? ` · 시간초과(대기 ${s.pendingQueries})` : ""}\n`,
  );
  for (const c of result.candidates.slice(0, 30)) {
    const tag = c.isKnown ? "[known]" : "[new]  ";
    const email = c.email || "(이메일 없음)";
    console.error(`${String(c.fitScore || 0).padStart(3)} ${tag} ${String(c.platform).padEnd(7)} ${c.channelName}`);
    console.error(`      ${email}  ·  ${c.channelType || ""}  ·  ${c.url}`);
    if (c.fitReason) console.error(`      → ${c.fitReason}`);
  }
}

main().catch((err) => {
  console.error("실패:", err?.message || err);
  process.exitCode = 1;
});
