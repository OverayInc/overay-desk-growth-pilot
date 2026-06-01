# Microsoft 로그인 설정 (회사 계정 · 경영진 전용)

이 대시보드는 회사 Microsoft(Azure AD / Entra ID) 계정으로만 접근할 수 있고,
**허용 목록(allowlist)에 있는 경영진 이메일만** 로그인됩니다. 인증은 두 겹입니다.

1. **클라이언트 게이트** — 브라우저가 MSAL로 회사 테넌트에 로그인. 미로그인/미승인이면 대시보드 화면이 뜨지 않음.
2. **서버 enforcement** — Node 서버가 모든 `/api/*` 요청의 Microsoft ID 토큰을 직접 검증(RS256/JWKS, 발급자/대상/테넌트/만료) 후 이메일 allowlist 확인. **토큰이 없거나 허용 목록에 없으면 401** — `curl`로도 데이터가 절대 안 나감.

> 핵심: 클라이언트 게이트는 UX, **진짜 잠금은 서버**입니다. 허용 이메일은 코드가 아니라 **환경변수/배포 시크릿**에 둡니다(개발자가 소스에서 명단을 못 봄).

---

## 1. Azure App Registration (1회)

Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**

| 항목 | 값 |
|------|-----|
| Name | `Launch Pilot Growth Console` |
| Supported account types | **Accounts in this organizational directory only (Single tenant)** ← 회사 직원만 |
| Redirect URI | Platform **Single-page application (SPA)** 선택 후 아래 origin 추가 |

**Redirect URI (SPA)** — 앱이 뜨는 origin을 그대로 (경로 없이):
- 로컬: `http://localhost:4173`, `http://127.0.0.1:4173`
- 운영: `https://<배포-도메인>` (예: `https://launchpilot.overay.dev`)

> 새 도메인에 배포할 때마다 그 origin을 SPA Redirect URI에 추가해야 로그인됩니다.

등록 후:
- **Application (client) ID** 복사 → `MS_CLIENT_ID` (공개값, 비밀 아님)
- **Directory (tenant) ID** 가 `f1f0a729-25be-432c-b9c9-24775c52aa1a` 인지 확인 (다르면 `MS_TENANT_ID`로 교체)
- **client secret 불필요** (SPA = public client, MSAL이 Auth Code + PKCE로 ID 토큰 수령)

(선택) **Token configuration** → optional claim `email` 추가 — 계정이 `preferred_username`에 이메일을 안 싣는 경우 대비. 보통은 `preferred_username`이 UPN/이메일이라 불필요.

---

## 2. 환경변수

`.env` (로컬) 또는 배포 시크릿:

```bash
MS_CLIENT_ID=<App Registration의 Application (client) ID>
MS_TENANT_ID=f1f0a729-25be-432c-b9c9-24775c52aa1a   # 기본값과 동일하면 생략 가능

# 접근 범위 — 아래 둘 중 하나(또는 둘 다):
AUTH_ALLOWED_DOMAIN=overay.com                       # ① 회사 직원 전체 (도메인). 비밀 아님 → ConfigMap OK
# AUTH_ALLOWED_EMAILS=ceo@overay.com,cfo@overay.com  # ② 경영진만 (명단). 민감 → SealedSecret 권장
# AUTH_ENABLED=true   # 선택. 강제 on(fail-closed)/off
```

**활성화 규칙**
- `MS_CLIENT_ID` + (`AUTH_ALLOWED_DOMAIN` **또는** `AUTH_ALLOWED_EMAILS`) 가 있으면 자동 enforcement ON.
- 셋 다 비면 OFF(=오늘처럼 개방) → 로컬/CI는 설정 없이 그대로 통과.
- 도메인 모드 = 해당 도메인 이메일이면 누구나 로그인(앱이 single-tenant라 회사 디렉터리 한정). 이메일 모드 = 명단에 있는 계정만. 둘 다 주면 합집합.
- `AUTH_ENABLED=true` 면 미설정이어도 강제 ON, `false` 면 강제 OFF.
- 부팅 로그에서 상태 확인: `[auth] Microsoft login ENFORCED · ... allow domain(s) overay.com` / `... DISABLED ...`

> ⚠️ 운영에서는 반드시 두 변수를 설정하세요. 미설정 시 OFF(개방)로 부팅되며 경고 로그가 찍힙니다.

---

## 3. 경영진 추가 / 제거

`AUTH_ALLOWED_EMAILS` 수정 후 재시작(`envFrom`은 자동 reload 안 됨):

```bash
# k8s 예시
kubectl rollout restart deployment/<svc> -n default
```

---

## 4. 동작 확인

```bash
# 활성화 상태에서:
curl -i https://<도메인>/api/games          # → 401 (토큰 없음)  ✅ 잠김
curl -s https://<도메인>/api/auth/config     # → {"enabled":true, "clientId":"...", ...}
curl -i https://<도메인>/api/health          # → 200 (public)
```

브라우저로 접속 → "Microsoft로 로그인" → 회사 계정 → 허용 목록이면 대시보드, 아니면 "접근 권한이 없습니다".

---

## 참고 — 구현 위치

| 영역 | 파일 |
|------|------|
| 서버 토큰 검증 + allowlist (stdlib, 무의존성) | `src/auth.mjs` |
| `/api/auth/config`, `/api/auth/me`, `/api/*` 게이트 | `src/server.mjs` (`handleApi`) |
| 브라우저 MSAL 로그인 게이트 | `public/auth.js` |
| 토큰 ↔ api() 브리지 | `public/auth-state.js` |
| 로그인 화면 / 로그아웃 UI | `public/index.html`, `public/styles.css` |
| 단위 테스트 | `tests/auth.test.mjs` |

게이트 제외(공개) 경로: `/api/health`, `/api/auth/config`, `/api/youtube/oauth/start`, `/api/youtube/oauth/callback`
(뒤 두 개는 전체 페이지 리다이렉트라 Bearer를 못 싣고, Google OAuth + state로 자체 보호됨.)
