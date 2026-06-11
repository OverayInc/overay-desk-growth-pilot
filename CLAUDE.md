# Overay Desk Marketing Hub

Overay Inc.의 제품 **Overay Desk**의 마케팅 관리 내부 웹툴. 사내 게임 런치 툴(Launch Pilot)에서 분기한 레포이며, GitHub fork 관계는 해제되어 독립 레포로 운영한다.

## 레포 관리 정책

- 분기점은 `game-launch-baseline` 태그. 원본 게임 런치 레포와는 **merge하지 않는다** — 필요한 픽스만 cherry-pick.
- 데이터 파일(DB)은 게임 런치 툴과 공유하지 않는다. 이 인스턴스는 빈 `data/app-data.json`에서 새로 시작하고 `KEY_ENCRYPTION_SECRET`도 별도 값을 쓴다.
- Reddit 자동화는 Overay Desk 전용 계정 세션을 쓴다. 세션 파일(`data/reddit-state.json`, `data/reddit-session-meta.json`)은 생성 후 커밋하는 것이 의도된 워크플로(프라이빗 레포, Docker가 레포에서 시드).
- 전환 작업의 기준 문서는 `docs/conversion-plan.md`. `docs/development-plan.md`, `docs/uiux-scenarios.md`, `docs/test-program.md`는 분기 전(게임 런치 툴) 기준 문서다.

## 스택과 구조

- Node >= 22, ESM(`.mjs`), 프레임워크 없음. 런타임 의존성은 `playwright` 하나(Reddit/페이지 렌더링 자동화용).
- `src/server.mjs` — 단일 파일 HTTP 서버(API + 정적 서빙). 데이터는 `data/app-data.json` JSON 파일이며 시크릿은 `KEY_ENCRYPTION_SECRET`으로 암호화 저장.
- `public/` — 정적 SPA(`app.js` 단일 파일, MSAL 기반 Microsoft 로그인 게이트).
- `src/discovery/` — 크리에이터 발굴 파이프라인(YouTube/Twitch/웹 검색 → gemma4 분석). `src/marketingAgent.mjs`가 LLM(gemma4 서버) 호출 레이어. 기본 발굴 시드는 비어 있음 — 제품 컨텍스트/시드는 Settings 또는 `LP_DISCOVERY_SEEDS`/`LP_DISCOVERY_GAME_CONTEXT`로 설정.
- `src/redditSession.mjs`, `src/redditBrowser.mjs` — Playwright 기반 Reddit 자동화.

## 명령어

- `npm start` / `npm run dev` — 서버 실행 (기본 `http://127.0.0.1:4173`)
- `npm test` — **서버를 먼저 띄운 뒤** 실행 (`node --test`, `TEST_BASE_URL`로 대상 변경)
- `npm run discover` — 크리에이터 발굴 CLI
- `npm run reddit:login` — Reddit 세션 생성

## 컨벤션

- UI 텍스트와 문서는 한국어, 코드 주석·커밋 메시지는 영어(`Area: description` 형식).
- 작업은 `feature/*` 브랜치 → PR → `main`.
