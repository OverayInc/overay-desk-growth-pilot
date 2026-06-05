// Discovery — standalone CLI runner.
//
// Lets you exercise the whole pipeline without touching the web server:
//
//   node src/discovery/run.mjs "spot the anomaly game" "Exit 8 gameplay"
//   node src/discovery/run.mjs --dry "관찰 공포 게임"      # retrieval only (no gemma)
//   node src/discovery/run.mjs --json "이상현상 찾기" > out.json
//
// Reads credentials from the environment (see .env.example). Prints a human
// summary by default, or full JSON with --json. It NEVER sends email — output
// is a list of "discovered" candidates for review.

import { runDiscovery } from "./pipeline.mjs";
import { discoveryConfigFromEnv, discoverySeeds, discoveryGameContext } from "./config.mjs";

function parseArgs(argv) {
  const flags = { dry: false, json: false, perSeed: 8, minFit: 0 };
  const seeds = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") flags.dry = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--per-seed") flags.perSeed = Number(argv[++i]) || flags.perSeed;
    else if (a === "--min-fit") flags.minFit = Number(argv[++i]) || 0;
    else seeds.push(a);
  }
  return { flags, seeds };
}

async function main() {
  const { flags, seeds: argSeeds } = parseArgs(process.argv.slice(2));
  const seeds = discoverySeeds(argSeeds);
  const config = discoveryConfigFromEnv();

  if (!flags.json) {
    console.error(`▶ 시드 ${seeds.length}개: ${seeds.join(", ")}`);
    console.error(`▶ 소스: youtube=${!!config.youtube.apiKey} twitch=${!!config.twitch.clientId} web=${config.web.provider || "off"}`);
    console.error(flags.dry ? "▶ dry 모드: 검색만 (gemma 분석 생략)\n" : "▶ 검색 → 크롤링 → gemma 분석\n");
  }

  const result = await runDiscovery(seeds, {
    config,
    gameContext: discoveryGameContext(),
    perSeed: flags.perSeed,
    minFitScore: flags.minFit,
    analyze: !flags.dry,
    enrich: !flags.dry,
    onProgress: flags.json ? () => {} : (m) => console.error(`  · ${m}`),
  });

  const runAt = new Date().toISOString();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ runAt, ...result }, null, 2));
    return;
  }

  console.error("");
  if (result.skipped.length) console.error(`⚠ 건너뜀: ${result.skipped.join(" | ")}`);
  if (result.errors.length) console.error(`⚠ 오류: ${result.errors.join(" | ")}`);
  const s = result.stats;
  console.error(`\n✓ 발견 ${s.rawFound} → 중복제거 ${s.deduped} → 분석 ${s.analyzed} → 채택 ${s.kept} (이메일 ${s.withEmail}, 신규 ${s.newCreators})\n`);
  for (const c of result.candidates.slice(0, 30)) {
    const tag = c.isKnown ? "[known]" : "[new]  ";
    const email = c.email || "(이메일 없음)";
    console.error(`${String(c.fitScore || 0).padStart(3)} ${tag} ${c.platform.padEnd(7)} ${c.channelName}`);
    console.error(`      ${email}  ·  ${c.channelType || ""}  ·  ${c.url}`);
    if (c.fitReason) console.error(`      → ${c.fitReason}`);
  }
}

main().catch((err) => {
  console.error("실패:", err?.message || err);
  process.exitCode = 1;
});
