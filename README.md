# Launch Pilot Growth Dashboard

여러 소형 Steam 게임의 홍보 활동을 관리하는 초경량 내부 웹툴입니다.

1차 MVP는 게임 포트폴리오, 연동 준비 체크리스트, 공용 Creator DB, Creator CSV Import, Campaign 관리, Steam Key 배포 기록, UTM 링크 생성, 이메일 초안/SMTP 발송 로그, Steamworks CSV Wizard, 웹 Settings 기반 API/SMTP 설정, 자동 동기화 스케줄, 동기화 로그, 데이터 내보내기에 집중합니다.

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

Steam Financial API Key와 SMTP 설정은 앱의 `Settings` 화면에서 저장하는 방식을 우선 사용합니다. 저장된 비밀값은 서버 데이터 파일에 암호화되어 보관되고, 화면과 API 응답에는 마스킹된 값만 표시됩니다.

운영 환경에서는 반드시 `KEY_ENCRYPTION_SECRET`을 고정된 강한 값으로 설정하세요. 이 값이 바뀌면 기존에 웹에서 저장한 비밀값을 복호화할 수 없습니다.

`.env` 값은 초기 부트스트랩이나 비상 폴백으로 계속 사용할 수 있습니다. 웹 Settings에 값이 있으면 웹 설정이 우선입니다.

## Steam API 동기화

Steam API를 실제로 호출하려면 앱의 `Settings` 화면에 Financial API Group 키를 저장합니다. 환경변수로 시작할 수도 있습니다.

```powershell
$env:STEAM_FINANCIAL_API_KEY="YOUR_STEAM_FINANCIAL_API_KEY"
npm start
```

Docker Compose에서 폴백 값을 쓰려면 `.env`에 같은 값을 넣으면 됩니다.

```env
STEAM_FINANCIAL_API_KEY=YOUR_STEAM_FINANCIAL_API_KEY
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

- [개발기획서](docs/development-plan.md)
- [UIUX 사용 시나리오](docs/uiux-scenarios.md)
- [테스트 프로그램](docs/test-program.md)
