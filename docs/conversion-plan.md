# Overay Desk 전환 계획

게임 런치 대시보드(Launch Pilot) → **Overay Desk 마케팅 관리 툴** 전환 작업 문서. 분기점은 `game-launch-baseline` 태그이며, 원본 레포와는 merge 없이 cherry-pick으로만 동기화한다.

## 확정된 사항

- 원본 레포와 GitHub fork 관계 해제. 통째 merge 금지, 필요한 픽스만 cherry-pick.
- **데이터(DB) 분리** — 새 인스턴스는 빈 데이터에서 시작하고 Creator DB도 새로 구축한다. `KEY_ENCRYPTION_SECRET`도 새 값 발급.
- **Reddit 세션 교체** — 기존(게임 런치 계정) 세션은 삭제 완료. Overay Desk 전용 계정으로 `npm run reddit:login` 후 세션 파일을 커밋한다.
- **1차 정체성 정리 완료** — 패키지명/UI 타이틀·로고/기본 메일 템플릿/에이전트 프롬프트/User-Agent에서 게임(Immersed Player) 문구 제거, OVERAY 브랜드 적용. 기본 발굴 시드는 비움.

## Keep / Adapt / Drop

| 영역 | 분류 | 메모 |
| --- | --- | --- |
| 인증(MSAL 로그인), 설정 암호화, Settings | Keep | |
| 메일 (SMTP, HTML 템플릿/WYSIWYG, 발송 로그) | Keep | 기본 템플릿은 중립 문구로 교체됨 — Overay Desk 실제 피치(제품 한 줄 소개·제공 가치)로 다듬기 필요 |
| Creator DB + 발굴 찾아봇 | Keep | 발굴 시드와 제품 컨텍스트를 Overay Desk 포지셔닝으로 설정 필요 (현재 기본 시드 비어 있음) |
| UTM 링크 생성 | Keep | |
| Reddit 마케팅 에이전트 | Keep | 새 계정 세션 + 타깃 서브레딧/문구 재설정 |
| 게임 포트폴리오 (Games 화면) | Adapt | 멀티 게임 모델 → Overay Desk 단일 제품(+에디션/채널) 모델로 단순화 |
| 키 풀 / 키 배포 기록 | Adapt | 판매 채널 결정에 따라 Steam 키 유지 또는 라이선스 키/프로모 코드로 일반화 |
| 스토어 리스팅 (Steam/Meta Horizon/itch/Epic) | Adapt | Overay Desk 실제 배포 채널 목록으로 교체 |
| Steam Financial API 동기화 | 보류 | Overay Desk가 Steam에서 판매되면 Keep, 아니면 Drop |
| Steamworks CSV Wizard | 보류 | 위와 동일 |

## 미결 질문 (제품 결정 필요)

1. Overay Desk의 배포/판매 채널은? (Steam, Meta Horizon Store, 자체 사이트/라이선스 판매 등)
2. 키 배포 모델: Steam 키 그대로 / 라이선스 키 / 프로모 코드?
3. 크리에이터 타깃은 누구인가 — 발굴 시드 키워드와 제품 컨텍스트 한 단락(`LP_DISCOVERY_GAME_CONTEXT` 또는 Settings)을 정해야 찾아봇이 의미 있게 동작한다.
4. 아웃리치 피치 한 줄(제품 소개)과 메일 서명/발신 주소 — 기본 메일 템플릿 9종의 문구 다듬기에 필요.
5. 대시보드 핵심 지표(KPI): 어떤 숫자를 매일 보고 싶은가?

## 다음 단계 제안

1. 위 미결 질문 확정 (특히 1·3번)
2. Games 화면 → 제품/채널 모델로 개편 + 기본 데이터에 Overay Desk 제품 시드
3. 메일 템플릿 문구를 실제 피치로 교체, 발굴 시드/컨텍스트 설정
4. Steam 의존 기능(Financial Sync, CSV Wizard) keep/drop 확정 후 정리
