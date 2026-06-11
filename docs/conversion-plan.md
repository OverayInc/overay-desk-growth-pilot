# Overay Desk 전환 계획

게임 런치 대시보드(Launch Pilot) → **Overay Desk 마케팅 관리 툴** 전환 작업 문서. 분기점은 `game-launch-baseline` 태그이며, 원본 레포와는 merge 없이 cherry-pick으로만 동기화한다.

## 확정된 사항

- 원본 레포와 GitHub fork 관계 해제. 통째 merge 금지, 필요한 픽스만 cherry-pick.
- **데이터(DB) 분리** — 새 인스턴스는 빈 데이터에서 시작하고 Creator DB도 새로 구축한다. `KEY_ENCRYPTION_SECRET`도 새 값 발급.
- **Reddit 세션 교체** — 기존(게임 런치 계정) 세션은 삭제 완료. Overay Desk 전용 계정으로 `npm run reddit:login` 후 세션 파일을 커밋한다.
- **1차 정체성 정리 완료** — 패키지명/UI 타이틀·로고/기본 메일 템플릿/에이전트 프롬프트/User-Agent에서 게임(Immersed Player) 문구 제거, OVERAY 브랜드 적용. 기본 발굴 시드는 비움.
- **단일 제품** — Overay Desk 하나만 관리한다. 제품 `game_overay_desk`가 기본 시드되고, UI에서 "제품 추가" 워크플로는 숨김(백엔드 CRUD는 테스트 호환용으로 유지).
- **런칭 스토어 3곳** — Meta Horizon Store(Quest) `meta_horizon` · Google Play(Galaxy XR) `play` · Pico Store `pico`. 세 리스팅이 planned 상태로 기본 시드되며, Steam은 런칭 채널이 아니다.
- **마케팅 채널 4개** — Facebook 페이지 · YouTube · Reddit · Discord. 캠페인 채널 입력의 기본 제안값으로 반영.
- **크리에이터 플랫폼 태그** — PC/VR/META → `QUEST` / `GALAXY_XR` / `PICO`로 교체(스토어 생태계 기준).
- **Steam UI 제거** — "데이터·동기화" 뷰(Steam 메트릭/동기화/CSV 위저드)와 Steam 설정 패널을 UI에서 제거/숨김. 백엔드 Steam 코드·API는 아직 남아 있음(아래 다음 단계).

## Keep / Adapt / Drop

| 영역 | 분류 | 메모 |
| --- | --- | --- |
| 인증(MSAL 로그인), 설정 암호화, Settings | Keep | |
| 메일 (SMTP, HTML 템플릿/WYSIWYG, 발송 로그) | Keep | 기본 템플릿은 중립 문구로 교체됨 — Overay Desk 실제 피치(제품 한 줄 소개·제공 가치)로 다듬기 필요 |
| Creator DB + 발굴 찾아봇 | Keep | 발굴 시드와 제품 컨텍스트를 Overay Desk 포지셔닝으로 설정 필요 (현재 기본 시드 비어 있음) |
| UTM 링크 생성 | Keep | |
| Reddit 마케팅 에이전트 | Keep | 새 계정 세션 + 타깃 서브레딧/문구 재설정 |
| 게임 포트폴리오 (Games 화면) | 완료 | 단일 제품(Overay Desk) 시드 + 제품 추가 UI 숨김. "제품 · 설정" 화면으로 개편 |
| 키 풀 / 키 배포 기록 | 완료(1차) | "스토어 키 · 프로모 코드"로 일반화. 키별 스토어(meta/play/pico) 구분 필드는 추후 |
| 스토어 리스팅 | 완료 | Meta Horizon(Quest) · Google Play(Galaxy XR) · Pico Store 3종으로 교체 + 기본 시드 |
| Steam Financial API 동기화 | Drop 확정 | UI 제거 완료. 백엔드 코드/엔드포인트/테스트 제거는 별도 정리 작업 |
| Steamworks CSV Wizard | Drop 확정 | 위와 동일 |

## 미결 질문 (제품 결정 필요)

1. 크리에이터 발굴 시드 키워드와 제품 컨텍스트 한 단락(`LP_DISCOVERY_GAME_CONTEXT` 또는 Settings) — 찾아봇이 의미 있게 돌려면 필요.
2. 아웃리치 피치 한 줄(제품 소개)과 메일 서명/발신 주소 — 기본 메일 템플릿 문구 다듬기에 필요.
3. 대시보드 KPI — 기존 지표(위시리스트/판매/매출)는 Steam 데이터 기반이라 현재 0으로 표시됨. Meta/Play/Pico 스토어별 지표 소스(수동 입력? 콘솔 CSV? API?)를 정해야 대시보드를 살릴 수 있다.
4. 스토어별 키/프로모 코드 운영 방식 — 키 풀에 스토어 구분 필드를 붙일지, 라벨 컨벤션으로 충분한지.

## 다음 단계 제안

1. 발굴 시드/제품 컨텍스트 설정 + 메일 템플릿 실제 피치 반영 (미결 1·2)
2. 대시보드 지표를 새 스토어 기준으로 재설계 (미결 3)
3. Steam 백엔드 코드 일괄 제거 (routes/sync/CSV/테스트) — UI는 이미 분리되어 있어 독립 작업 가능
4. Facebook 페이지·Discord 채널 운영 로그/지표가 필요해지면 YouTube·Reddit 화면과 같은 패턴으로 추가
