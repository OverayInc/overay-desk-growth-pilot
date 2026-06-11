> ⚠️ 이 문서는 분기 전 게임 런치 툴(`game-launch-baseline` 태그) 기준입니다. Overay Desk 전환 방향은 [conversion-plan.md](conversion-plan.md)를 보세요.

# Launch Pilot Growth Dashboard 개발기획서

## 1. 목표

여러 소형 Steam 게임의 홍보 활동을 한곳에서 추적하는 초경량 내부 웹툴을 만든다.

핵심 목적은 유튜버/스트리머 연락, Steam Key 배포, UTM 링크 생성, Steamworks CSV 성과 업로드, 위시리스트/구매 전환 확인을 하나의 흐름으로 연결하는 것이다.

## 2. 제품 정의

제품명: Launch Pilot Growth Dashboard

주 사용자:

- 1~5명 규모의 인디게임 팀
- 마케팅 전담 인력이 없거나 적은 팀
- YouTube, TikTok, X, Reddit, Discord, 이메일을 직접 운영하는 팀

핵심 질문:

- 전체 포트폴리오와 게임별 위시리스트/판매가 얼마나 늘었는가?
- 어떤 캠페인과 채널이 방문, 위시리스트, 구매로 이어졌는가?
- 누구에게 연락했고, 누가 답장했으며, 누구에게 키를 보냈는가?
- 어떤 크리에이터에게 다음으로 연락해야 하는가?

## 3. 1차 MVP 범위

1차 MVP는 Steamworks API 자동 연동보다 CSV 업로드와 수동 관리에 집중한다.

포함 기능:

- Today Dashboard
- Campaign Dashboard
- 공용 Creator DB
- Creator CSV Import
- Creator CRM
- Steam Key 배포 기록
- UTM 링크 생성기
- Steamworks CSV 업로드 및 캠페인별 성과 집계
- 게임 포트폴리오 관리와 전체/개별 게임 필터
- 게임별 연동 준비 체크리스트와 설정 수정
- Steam API 동기화 상태/수동 실행 화면
- Steam API 동기화 상세 로그
- Steam API 자동 동기화 스케줄
- 웹 Settings에서 Steam API Key와 SMTP 설정 관리
- CSV 업로드 전 미리보기와 중복 감지
- SMTP 기반 이메일 발송과 발송 로그
- 안전한 JSON 내보내기
- Docker Compose 기반 로컬 실행
- API 스모크 테스트 프로그램

제외 기능:

- Steamworks 로그인 자동화
- Steamworks 페이지 스크래핑
- YouTube/TikTok/X 자동 수집
- 이메일 자동 발송
- 개인 단위 추적

## 4. 핵심 화면

### Portfolio Overview

- 관리 중인 게임 목록
- 게임별 단계, 장르, Steam App ID
- 게임별 누적 방문, 위시리스트, 구매, 매출
- 게임별 크리에이터/캠페인/키 수
- 전체 보기와 개별 게임 보기 전환

### Today Dashboard

- 오늘 위시리스트 증가
- 오늘 판매량
- 최근 7일 위시리스트
- 최근 7일 매출
- 성과 좋은 캠페인
- 연락 우선순위가 높은 크리에이터

### Campaign Dashboard

- 캠페인명
- 시작일
- 채널
- 보낸 이메일 수
- 답장 수
- 키 발송 수
- 영상 업로드 수
- Steam 방문 수
- 위시리스트 수
- 구매 수
- 예상 매출

### Creator CRM

- 공용 크리에이터 DB를 기준으로 채널명, 이메일, 국가, 태그, 평균 조회수, 적합도 점수를 누적 관리
- CSV로 크리에이터 후보를 대량 추가/갱신
- 각 게임/캠페인별 연락 레코드는 공용 DB 프로필을 참조
- 게임별 Steam 링크와 UTM이 포함된 이메일 초안 생성 및 SMTP 발송 로그 기록

### Game Outreach CRM

- 채널명
- 플랫폼
- 이메일
- 국가
- 장르/태그
- 구독자
- 평균 조회수
- 적합도 점수
- 연락 상태
- 캠페인
- UTM 링크

### Key Management

- 내부 키 ID
- 수신자
- 이메일
- 캠페인
- 상태
- 마스킹된 Steam Key
- UTM 링크
- 메모

### Steam Metrics

- 일별 방문
- 일별 위시리스트
- 일별 구매
- 국가별 성과
- 캠페인별 성과
- CSV 업로드 결과

### Steam API Sync

- 웹 Settings 또는 환경변수 폴백을 통한 API 키 설정 여부 확인
- Steam App ID가 설정된 게임 수 확인
- 게임별 연동 준비 상태 확인
- 위시리스트 API 수동 동기화
- 판매 API 수동 동기화 준비
- 최근 동기화 실행 기록
- 동기화 실행별 이벤트/경고 상세 확인

## 5. 데이터 모델

### creatorProfiles

- id
- channelName
- handle
- platform
- email
- country
- tags
- subscribers
- averageViews
- fitScore
- status
- note
- createdAt
- updatedAt

### creators

- id
- creatorProfileId
- gameId
- channelName
- platform
- email
- country
- tags
- subscribers
- averageViews
- fitScore
- status
- campaignId
- utmLink
- note
- createdAt
- updatedAt

### campaigns

- id
- gameId
- name
- startDate
- endDate
- channels
- goal
- sentEmails
- replies
- keysSent
- videosUploaded
- createdAt
- updatedAt

### influencerKeys

- id
- gameId
- recipientName
- recipientEmail
- creatorId
- campaignId
- status
- steamKeyEncrypted
- steamKeyMasked
- utmLink
- note
- createdAt
- updatedAt

### steamDailyMetrics

- id
- gameId
- date
- campaignId
- campaignName
- country
- visits
- wishlists
- purchases
- revenue
- activations
- refunds
- source
- createdAt

### integrationSettings

- steamFinancialApiKeyEncrypted
- steamFinancialApiKeyMasked
- smtpHost
- smtpPort
- smtpUser
- smtpPassEncrypted
- smtpPassMasked
- smtpSecure
- smtpStarttls
- emailFrom
- emailReplyTo
- emailSendMode
- updatedAt

## 6. API 설계

- `GET /api/health`
- `GET /api/games`
- `POST /api/games`
- `PUT /api/games/:id`
- `GET /api/dashboard`
- `GET /api/readiness`
- `GET /api/creator-profiles`
- `POST /api/creator-profiles`
- `POST /api/import/creator-csv/preview`
- `POST /api/import/creator-csv`
- `GET /api/creators`
- `POST /api/creators`
- `GET /api/campaigns`
- `POST /api/campaigns`
- `GET /api/keys`
- `POST /api/keys`
- `GET /api/steam-metrics`
- `POST /api/email-drafts`
- `GET /api/email/status`
- `POST /api/email-send`
- `GET /api/outreach-logs`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/utm-links`
- `GET /api/steam-sync/status`
- `GET /api/sync-schedule`
- `PUT /api/sync-schedule`
- `POST /api/sync-schedule/run-due`
- `GET /api/steam-sync/runs/:id`
- `POST /api/steam-sync/run`
- `POST /api/import/steam-csv/preview`
- `POST /api/import/steam-csv`
- `GET /api/export`

## 7. CSV 형식

1차 CSV 업로드는 아래 헤더를 기본으로 한다.

```csv
date,campaignId,campaignName,country,visits,wishlists,purchases,revenue,activations,refunds
2026-05-28,campaign_demo_may,Demo Key Push,KR,220,31,6,89.94,4,1
```

필수 헤더:

- date
- 업로드 화면에서 선택한 게임, 또는 CSV 내 gameId/appId/gameName
- campaignId 또는 campaignName

숫자 필드:

- visits
- wishlists
- purchases
- revenue
- activations
- refunds

## 8. 보안 원칙

- Publisher Web API Key는 프론트엔드에 노출하지 않는다.
- Steam Financial API Key와 SMTP Password는 웹 Settings에서 저장할 수 있지만, 서버에서 암호화 보관하고 API 응답에는 마스킹 값만 포함한다.
- 환경변수의 Steam/SMTP 값은 초기 부트스트랩과 폴백 용도로만 사용하며, 웹 Settings 값이 있으면 웹 Settings를 우선한다.
- Steam Key 원문은 API 응답에 포함하지 않는다.
- Steam Key는 서버에서 암호화 저장한다.
- 기본 개발 환경에서는 `KEY_ENCRYPTION_SECRET`을 설정하지 않아도 동작하지만, 운영 환경에서는 반드시 별도 비밀값을 사용하고 저장 후 변경하지 않는다.
- UTM은 개인 식별이 아니라 캠페인 단위 집계로 취급한다.
- 크리에이터 이메일은 공개 연락처와 직접 수집한 동의 기반 데이터 중심으로 관리한다.

## 9. 기술 구조

1차 MVP는 설치와 Docker 실행을 쉽게 하기 위해 외부 런타임 의존성 없는 Node.js 앱으로 구현한다.

```text
Launch Pilot Growth Dashboard
  ├─ public/             관리자 웹 UI
  ├─ src/server.mjs      API 서버와 정적 파일 서버
  ├─ data/app-data.json  로컬 JSON 데이터 저장소
  ├─ tests/              API 테스트 프로그램
  └─ docker-compose.yml  로컬 실행 구성
```

2차부터는 아래 구조로 확장한다.

```text
Next.js Admin App
  ├─ Dashboard
  ├─ Creator CRM
  ├─ Campaigns
  └─ Steam Metrics

Backend API
  ├─ Steamworks API 연동
  ├─ CSV 업로드/파싱
  ├─ UTM 링크 생성
  ├─ 이메일 발송 기록
  └─ 키 관리

PostgreSQL / Supabase
  ├─ creators
  ├─ campaigns
  ├─ steam_daily_metrics
  ├─ influencer_keys
  └─ outreach_logs
```

## 10. 로드맵

### 1차

- 10개 내외 게임 포트폴리오 관리
- 유튜버/스트리머 리스트 관리
- 이메일/DM 상태 관리
- Steam Key 배포 기록
- 유튜버별 UTM 링크 자동 생성
- Steamworks CSV 업로드
- Steam Wishlist API 동기화
- Steam Sales API 동기화 실행 틀
- 캠페인별 위시리스트/구매 성과 표시

### 2차

- Steamworks Sales Data API 연동
- Wishlist 리포트 자동 수집
- 일별 자동 집계
- 국가별 성과 분석
- 할인/이벤트 캘린더

### 3차

- YouTube 채널 후보 수집
- 이메일 초안 생성
- 성과 기반 크리에이터 추천
- Reddit/X/TikTok 반응 추적
- 출시 후 리뷰/커뮤니티 모니터링

## 11. 완료 기준

- `npm start`로 로컬 앱 실행 가능
- `docker compose up --build`로 앱 실행 가능
- 브라우저에서 Dashboard/CRM/Campaign/Keys/Metrics 화면 사용 가능
- CSV 업로드 후 대시보드 수치 반영
- UTM 링크 생성 가능
- API 스모크 테스트 통과
