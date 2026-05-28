# Growth Dashboard MVP 테스트 프로그램

## 목적과 범위

이 문서는 Growth Dashboard MVP의 API 계약과 핵심 사용자 흐름을 검증하기 위한 테스트 전략을 정리한다. 테스트 소유 범위는 `tests/**`와 `docs/test-program.md`로 제한하며, 앱 구현 코드나 패키지 설정은 수정하지 않는다.

대상 계약은 다음과 같다.

- 정적 UI: `GET /`
- 헬스체크: `GET /api/health` -> `{ ok: true }`
- 게임 목록: `GET /api/games`, `POST /api/games`
- 게임 설정: `PUT /api/games/:id`
- 대시보드: `GET /api/dashboard`
- 연동 준비: `GET /api/readiness`
- 목록 API: `GET /api/creator-profiles`, `GET /api/creators`, `GET /api/campaigns`, `GET /api/keys`, `GET /api/steam-metrics`
- 생성 API: `POST /api/creator-profiles`, `POST /api/creators`, `POST /api/campaigns`, `POST /api/keys`
- Creator CSV: `POST /api/import/creator-csv/preview`, `POST /api/import/creator-csv`
- 이메일 초안/발송: `POST /api/email-drafts`, `GET /api/email/status`, `POST /api/email-send`, `GET /api/outreach-logs`
- 웹 Settings: `GET /api/settings`, `PUT /api/settings`
- UTM 생성: `POST /api/utm-links`
- Steam API 동기화: `GET /api/steam-sync/status`, `POST /api/steam-sync/run`
- Steam API 동기화 상세: `GET /api/steam-sync/runs/:id`
- Steam API 자동 스케줄: `GET /api/sync-schedule`, `PUT /api/sync-schedule`, `POST /api/sync-schedule/run-due`
- Steam CSV 미리보기/업로드: `POST /api/import/steam-csv/preview`, `POST /api/import/steam-csv` with JSON `{ csvText }`
- 안전한 내보내기: `GET /api/export`

## 테스트 전략

### 1. 스모크 테스트

서버가 실행 중인 상태에서 가장 얇은 경로로 앱의 생존성을 확인한다.

- `/`가 2xx 응답을 반환하고 HTML 문서를 제공하는지 확인한다.
- `/api/health`가 2xx와 `{ ok: true }`를 정확히 반환하는지 확인한다.
- `/api/games`가 JSON 배열을 반환하는지 확인한다.
- `/api/dashboard`가 JSON 객체를 반환하는지 확인한다.
- 각 목록 API가 JSON 배열을 반환하는지 확인한다.

### 2. API 회귀 테스트

성장 대시보드의 핵심 데이터 흐름이 끊기지 않았는지 확인한다.

- 고유한 테스트 실행 ID를 사용해 game, creator, campaign, key를 생성한다.
- 생성한 game의 연동 설정을 수정한다.
- 생성 응답이 JSON 객체인지 확인한다.
- 생성 직후 목록 API를 다시 조회해 새 데이터가 노출되는지 확인한다.
- 공용 creator profile이 게임 없이 생성되고, 게임별 creator 생성 시 자동 연결되는지 확인한다.
- Creator CSV preview/import가 신규/갱신/중복 수를 반환하는지 확인한다.
- 이메일 초안 API가 수신자, 제목, 본문, `mailto`, UTM 링크를 반환하는지 확인한다.
- SMTP 미설정 상태에서 실제 발송 요청이 `blocked` 로그로 안전하게 기록되는지 확인한다.
- 웹 Settings에 Steam API Key와 SMTP Password를 저장해도 API 응답과 export에 원문 비밀값이 노출되지 않는지 확인한다.
- CSV 업로드 전 preview가 신규/교체/중복 수를 반환하는지 확인한다.
- Steam Sync 실행 후 run detail을 조회한다.
- Sync schedule 저장과 강제 실행이 안전하게 동작하는지 확인한다.
- export 응답이 Steam key 암호문을 포함하지 않는지 확인한다.
- export 응답이 웹 Settings의 Steam API Key, SMTP Password 원문을 포함하지 않는지 확인한다.
- UTM 링크 생성 API가 `utm_source`, `utm_medium`, `utm_campaign` 값을 포함한 링크 또는 링크 정보를 반환하는지 확인한다.
- Steam CSV 샘플을 업로드한 뒤 Steam metrics 목록에서 CSV 날짜 데이터가 조회되는지 확인한다.

### 3. 수동 탐색 테스트

자동 테스트가 잡기 어려운 화면 품질, 입력 UX, 오류 메시지, 빈 상태를 브라우저에서 확인한다.

- 첫 화면에서 대시보드 핵심 수치와 목록이 한눈에 들어오는지 확인한다.
- 빈 데이터 상태에서 카드, 테이블, CTA가 깨지지 않는지 확인한다.
- 긴 creator 이름, 긴 campaign 이름, 긴 UTM URL이 레이아웃을 밀어내지 않는지 확인한다.
- 모바일 폭과 데스크톱 폭에서 텍스트 겹침, 버튼 잘림, 가로 스크롤이 없는지 확인한다.
- 잘못된 입력을 보냈을 때 사용자가 원인을 이해할 수 있는 오류 메시지가 표시되는지 확인한다.

## 자동 테스트 구성

자동 테스트 파일은 `tests/api-smoke.test.mjs` 하나로 구성한다.

- 실행 도구: Node 22 내장 `node:test`
- HTTP 클라이언트: Node 22 전역 `fetch`
- 외부 라이브러리: 사용하지 않음
- 기본 대상 URL: `http://127.0.0.1:4173`
- 변경 가능한 환경변수: `TEST_BASE_URL`
- CSV fixture: `tests/fixtures/steam_metrics.csv`

테스트는 서버를 직접 실행하지 않는다. 실제 앱 서버가 이미 떠 있다고 가정하고 HTTP 요청만 보낸다.

### 실행 방법

PowerShell 기본 실행:

```powershell
node --test tests/api-smoke.test.mjs
```

다른 포트나 배포 환경을 대상으로 실행:

```powershell
$env:TEST_BASE_URL = "http://127.0.0.1:4173"
node --test tests/api-smoke.test.mjs
```

macOS/Linux 예시:

```bash
TEST_BASE_URL=http://127.0.0.1:4173 node --test tests/api-smoke.test.mjs
```

## 수동 체크리스트

### 서버와 기본 페이지

- 서버가 정상 기동되고 콘솔에 치명적인 오류가 없는가?
- `GET /`가 브라우저에서 열리는가?
- 첫 화면이 실제 앱 화면으로 보이며 빈 마케팅 페이지만 표시되지 않는가?
- 새로고침해도 앱이 정상적으로 다시 로드되는가?

### 헬스체크와 API 기본 응답

- `GET /api/health`가 `{ ok: true }`를 반환하는가?
- `GET /api/dashboard`가 JSON 객체를 반환하는가?
- 주요 목록 API가 초기 데이터가 없어도 빈 배열로 안정적으로 응답하는가?
- API 오류가 HTML 오류 페이지 대신 JSON 형태로 일관되게 반환되는가?

### Creator 흐름

- 공용 creator DB profile을 게임 없이 생성할 수 있는가?
- 게임별 creator 생성 시 공용 DB profile이 자동 생성 또는 연결되는가?
- creator를 생성할 수 있는가?
- 필수 입력값 누락 시 4xx 오류와 이해 가능한 메시지를 반환하는가?
- 생성된 creator가 목록과 대시보드에 반영되는가?
- 동일하거나 유사한 이름을 가진 creator가 있어도 UI가 구분 가능한가?
- 게임을 선택한 상태에서 이메일 초안과 `mailto` 링크를 생성할 수 있는가?

### Campaign 흐름

- campaign을 생성할 수 있는가?
- 예산, 목표, 기간, 상태 값이 저장되고 다시 조회되는가?
- 잘못된 날짜 범위나 숫자 값에 대한 방어가 있는가?
- campaign 생성 후 대시보드 요약 값이 갱신되는가?

### Key 흐름

- key 또는 key batch를 생성할 수 있는가?
- creator/campaign과 연결된 값이 있으면 목록에서 확인 가능한가?
- 원문 Steam Key와 암호문 필드가 API 응답에 노출되지 않는가?
- 중복 key, 빈 key, 너무 긴 key 값 처리 정책이 안정적인가?
- 생성 후 목록 API에서 바로 조회되는가?

### UTM 생성 흐름

- base URL, source, medium, campaign 값으로 UTM 링크를 생성할 수 있는가?
- 반환 링크에 `utm_source`, `utm_medium`, `utm_campaign`이 포함되는가?
- 이미 query string이 있는 base URL에서도 `?`와 `&` 처리가 올바른가?
- 공백, 한글, 특수문자가 URL 인코딩되는가?

### Steam CSV 업로드 흐름

- `csvText` JSON 필드로 CSV를 업로드할 수 있는가?
- 헤더가 있는 CSV를 정상 파싱하는가?
- 날짜, page views, wishlist additions, followers, units sold, revenue 값이 저장되는가?
- 업로드 후 `GET /api/steam-metrics`에서 방금 업로드한 날짜가 조회되는가?
- 빈 CSV, 헤더 누락 CSV, 숫자 형식 오류 CSV에서 적절한 4xx 오류를 반환하는가?

### 웹 Settings 흐름

- `PUT /api/settings`로 Steam API Key와 SMTP 설정을 저장할 수 있는가?
- 저장 응답과 `GET /api/settings`가 원문 비밀값 대신 마스킹된 상태만 반환하는가?
- `GET /api/steam-sync/status`가 웹 저장 키를 우선 source로 표시하는가?
- `GET /api/email/status`가 웹 저장 SMTP 설정과 발송 모드를 우선 반영하는가?
- 체크박스로 저장된 키/패스워드를 삭제할 수 있는가?

## 회귀 테스트 시나리오

### 시나리오 A: 새 환경 최초 기동

1. 데이터 파일이나 DB가 비어 있는 상태에서 서버를 기동한다.
2. `GET /`, `GET /api/health`, `GET /api/dashboard`를 호출한다.
3. 목록 API 5종을 호출한다.
4. 기대 결과: 모든 요청이 2xx로 응답하고, 목록 API는 빈 배열 또는 정상 배열을 반환한다.

### 시나리오 B: 핵심 데이터 생성 후 조회

1. 고유한 game을 생성한다.
2. 고유한 creator를 생성한다.
3. 고유한 campaign을 생성한다.
4. 고유한 key를 생성한다.
5. 목록 API를 다시 조회한다.
6. 기대 결과: 생성한 데이터가 각 목록 응답에 포함된다.

### 시나리오 C: UTM 링크 생성

1. creator handle과 campaign 이름을 source/campaign 값으로 사용한다.
2. `POST /api/utm-links`를 호출한다.
3. 기대 결과: 반환 본문에 UTM 파라미터가 포함되고 base URL이 유지된다.

### 시나리오 D: Steam CSV 임포트

1. `tests/fixtures/steam_metrics.csv` 내용을 읽는다.
2. `{ csvText }`로 `POST /api/import/steam-csv`를 호출한다.
3. `GET /api/steam-metrics`를 호출한다.
4. 기대 결과: fixture에 있는 날짜와 지표 값이 조회 응답에 반영된다.

### 시나리오 E: 반복 실행 안정성

1. 자동 테스트를 연속 2회 실행한다.
2. 각 실행은 서로 다른 실행 ID를 사용한다.
3. 기대 결과: 이전 실행 데이터가 남아 있어도 새 실행이 실패하지 않는다.

## 릴리스 전 권장 기준

- 자동 테스트 `tests/api-smoke.test.mjs`가 대상 환경에서 통과한다.
- 수동 체크리스트의 기본 페이지, 생성 흐름, UTM 생성, CSV 업로드 항목이 통과한다.
- known issue가 있으면 어떤 계약을 위반하는지와 사용자 영향도를 릴리스 노트에 기록한다.
- 데이터 저장소를 초기화한 상태와 기존 데이터가 있는 상태를 각각 한 번 이상 확인한다.
