# Overay Desk Marketing Hub

오버레이(Overay Inc.)의 **Overay Desk** 제품 마케팅 활동을 관리하는 초경량 내부 웹툴입니다.

이 레포는 사내 게임 런치 툴(Launch Pilot)에서 분기했습니다(fork 관계는 해제됨). 분기점은 `game-launch-baseline` 태그로 남겨두었고, 원본과는 merge 없이 필요한 수정만 cherry-pick합니다. 데이터(DB)도 원본 툴과 공유하지 않고 이 인스턴스 전용으로 새로 시작합니다. 전환 작업의 결정 사항과 남은 일은 [전환 계획](docs/conversion-plan.md)을 보세요.

현재 기능셋: 제품/스토어 리스팅 관리, 공용 Creator DB + 크리에이터 발굴(찾아봇), Campaign 관리, 키 배포 기록, UTM 링크 생성, 이메일 템플릿(WYSIWYG)/SMTP 발송 로그, Steam CSV/API 동기화, Reddit 마케팅 에이전트, 웹 Settings 기반 API/SMTP 설정, 자동 동기화 스케줄, 데이터 내보내기.

## 빠른 시작

```powershell
npm start
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다.

## Docker Compose

```powershell
docker compose up --build
```

기본 포트는 `4173`입니다.

## 연동 설정

API Key와 SMTP 설정은 앱의 `Settings` 화면에서 저장하는 방식을 우선 사용합니다. 저장된 비밀값은 서버 데이터 파일에 암호화되어 보관되고, 화면과 API 응답에는 마스킹된 값만 표시됩니다.

운영 환경에서는 반드시 `KEY_ENCRYPTION_SECRET`을 고정된 강한 값으로 설정하세요. 이 값이 바뀌면 기존에 웹에서 저장한 비밀값을 복호화할 수 없습니다. 이 인스턴스는 게임 런치 툴과 분리된 새 DB로 시작하므로 시크릿도 새 값을 발급해 쓰세요.

`.env` 값은 초기 부트스트랩이나 비상 폴백으로 계속 사용할 수 있습니다. 웹 Settings에 값이 있으면 웹 설정이 우선입니다.

## Steam API 동기화

Overay Desk가 Steam에 리스팅된 경우, 앱의 `Settings` 화면에 Financial API Group 키를 저장하면 판매 데이터 동기화가 동작합니다. 환경변수로 시작할 수도 있습니다.

```powershell
$env:STEAM_FINANCIAL_API_KEY="YOUR_STEAM_FINANCIAL_API_KEY"
npm start
```

키가 없으면 앱의 Steam Sync 화면에서 연동 상태와 실행 계획만 확인할 수 있습니다.

## 메일 발송

실제 메일을 보내려면 앱의 `Settings` 화면에 SMTP 정보를 저장합니다. 설정이 없으면 발송 버튼은 실패하지 않고 `blocked` 로그만 남깁니다. 환경변수 폴백도 지원합니다.

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=mailer@example.com
SMTP_PASS=YOUR_SMTP_PASSWORD
EMAIL_FROM=mailer@example.com
EMAIL_REPLY_TO=team@example.com
```

## Reddit 세션

게임 런치 시절의 Reddit 세션은 이 레포에서 제거했습니다. Overay Desk 전용 계정으로 세션을 새로 만드세요:

```powershell
npm run reddit:login
```

운영 배포(Docker)는 레포에 커밋된 세션 파일을 시드하므로, 생성된 `data/reddit-state.json`과 `data/reddit-session-meta.json`을 커밋합니다(프라이빗 내부 레포 전제의 의도된 워크플로).

## 테스트

서버를 먼저 실행한 뒤:

```powershell
npm test
```

테스트 대상 주소를 바꾸려면:

```powershell
$env:TEST_BASE_URL="http://127.0.0.1:4173"; npm test
```

## 주요 문서

- [Overay Desk 전환 계획](docs/conversion-plan.md)
- [개발기획서](docs/development-plan.md) (분기 전 기준)
- [UIUX 사용 시나리오](docs/uiux-scenarios.md) (분기 전 기준)
- [테스트 프로그램](docs/test-program.md) (분기 전 기준)
