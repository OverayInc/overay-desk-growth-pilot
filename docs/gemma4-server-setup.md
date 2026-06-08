# gemma4 AI 서버 — 새 컴퓨터에 세팅하기

launch-pilot 대시보드의 AI 기능(메일 초안 생성·번역, 크리에이터 찾아봇 분석)은
**자체 호스팅한 gemma4 서버**(vLLM)에 붙어서 동작합니다. 지금은 `5090native` 박스
한 대가 이 역할을 하고 있고, 대시보드는 그 박스의 OpenAI 호환 API를 호출합니다.

이 문서는 **다른 컴퓨터(B 머신)에 같은 서버를 처음부터 새로 올리는** 절차입니다.
끝나면 B 머신이 `http://<B-IP>:8000/v1` 에서 동일한 API를 서빙하고,
launch-pilot의 `LP_AI_BASE_URL` 만 바꿔주면 그쪽으로 붙습니다.

> 현재 운영값 (기준)
> - API: `http://192.168.50.107:8000/v1` (`5090native`)
> - 모델 ID: `gemma-4-26b-a4b`
> - 모델 가중치: `nvidia/Gemma-4-26B-A4B-NVFP4` (MoE 26B / 활성 4B, NVFP4 ~16.5GB)
> - 측정치: ~101 tok/s, 32K 컨텍스트, GPU 메모리 ~29/32GB

---

## 0. 사전 준비물 (하드웨어 · OS)

| 항목 | 요구사항 | 비고 |
|------|----------|------|
| GPU | **NVIDIA Blackwell (sm_120)**, VRAM **24GB+** 권장(32GB 여유) | RTX 5090 기준. NVFP4는 Blackwell에서 네이티브 |
| OS | Ubuntu 24.04 LTS (또는 동급 리눅스) | Proxmox VM도 가능 |
| 드라이버 | NVIDIA **595 계열** + CUDA 12.x 런타임 | `nvidia-smi` 가 GPU를 보여야 함 |
| Python | 3.10 ~ 3.12 | venv 사용 |
| 디스크 | 모델 + venv 합쳐 **~30GB** 여유 | |
| 네트워크 | 대시보드 서버와 같은 LAN 또는 SSH 도달 가능 | |

> ⚠️ **드라이버 주의 (5090 계열 공통):** 프리빌트(비-DKMS) 595 드라이버는 커널이
> 올라가면 모듈이 깨져서 `nvidia-smi` 가 안 됩니다. 커널 자동 업그레이드를 잠가두세요:
> ```bash
> sudo apt-mark hold linux-generic linux-image-generic linux-headers-generic
> ```

확인:
```bash
nvidia-smi                # GPU·드라이버·CUDA 버전 확인
nvidia-smi --query-gpu=compute_cap --format=csv   # 12.0 이면 Blackwell sm_120
```

---

## 1. 작업 디렉터리 + Python venv

서버 설정은 다른 프로젝트와 섞이지 않게 **`~/gemma4` 아래 독립적으로** 둡니다.

```bash
mkdir -p ~/gemma4/models
cd ~/gemma4

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

vLLM 설치 (Gemma 4 + NVFP4 지원은 **vLLM 0.20.1 이상** 필요):

```bash
pip install "vllm>=0.20.1"
# 모델 다운로드용
pip install "huggingface_hub[cli]"
```

> 설치 후 `python -c "import vllm; print(vllm.__version__)"` 로 0.20.1+ 확인.
> 0.20.1 은 이미 `Gemma4ForConditionalGeneration` 와 `modelopt_fp4`(NVFP4)를
> `quantization_config` 에서 자동 인식하므로 별도 업그레이드/패치 불필요.

---

## 2. 모델 다운로드 (HF 게이트 모델)

Gemma 4 는 Hugging Face **게이트 모델**입니다. 먼저 모델 페이지에서 라이선스 동의가
필요하고, 동의한 HF 계정으로 로그인해야 받아집니다(운영은 `seosukhyun` / Overay org 계정 사용).

1. 브라우저에서 `https://huggingface.co/nvidia/Gemma-4-26B-A4B-NVFP4` 접속 → 라이선스 동의
2. [HF 토큰](https://huggingface.co/settings/tokens)에서 **read** 토큰 발급
3. 로그인 후 다운로드:

```bash
huggingface-cli login          # 위에서 발급한 토큰 입력
huggingface-cli download nvidia/Gemma-4-26B-A4B-NVFP4 \
  --local-dir ~/gemma4/models/Gemma-4-26B-A4B-NVFP4
```

> 받은 폴더에 `config.json`(안에 `quantization_config` 로 NVFP4 표기) + safetensors 들이
> 있으면 정상. 총 ~16.5GB.

---

## 3. 런처 스크립트 (`gemma4.sh`)

vLLM 을 tmux 세션 안에서 띄우는 관리 스크립트입니다. `up | stop | status | logs | restart`
서브커맨드를 제공합니다. `~/gemma4/gemma4.sh` 로 저장하세요.

```bash
#!/usr/bin/env bash
# gemma4 — vLLM 마케팅 에이전트 서버 런처
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"                       # 독립 venv. 다른 venv 재사용시 경로만 변경
MODEL_DIR="$HERE/models/Gemma-4-26B-A4B-NVFP4"
SERVED_NAME="gemma-4-26b-a4b"            # 대시보드의 LP_AI_MODEL 과 반드시 일치
PORT=8000
SESSION="gemma4"
GPU_MEM_UTIL=0.90
MAX_LEN=32768                            # 32K 컨텍스트
LOG="$HERE/gemma4.log"

start() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "already running (tmux: $SESSION)"; exit 0
  fi
  tmux new-session -d -s "$SESSION" \
    "source '$VENV/bin/activate'; \
     vllm serve '$MODEL_DIR' \
       --served-model-name '$SERVED_NAME' \
       --host 0.0.0.0 --port $PORT \
       --gpu-memory-utilization $GPU_MEM_UTIL \
       --max-model-len $MAX_LEN \
       --max-num-batched-tokens 8192 \
       2>&1 | tee '$LOG'"
  echo "started → http://0.0.0.0:$PORT/v1 (model: $SERVED_NAME)"
}

case "${1:-}" in
  up|start)   start ;;
  stop)       tmux kill-session -t "$SESSION" 2>/dev/null && echo stopped || echo "not running" ;;
  restart)    "$0" stop || true; sleep 2; "$0" up ;;
  status)     tmux has-session -t "$SESSION" 2>/dev/null && echo "running" || echo "stopped"; \
              curl -s "http://localhost:$PORT/v1/models" || true ;;
  logs)       tail -f "$LOG" ;;
  *)          echo "usage: $0 {up|stop|restart|status|logs}"; exit 1 ;;
esac
```

```bash
chmod +x ~/gemma4/gemma4.sh
~/gemma4/gemma4.sh up
~/gemma4/gemma4.sh logs      # "Application startup complete" 뜰 때까지 (첫 로딩 1~2분)
```

> **중요 — `--max-num-batched-tokens`:** Gemma 4 는 멀티모달이라 이 값이 `2496` 미만이면
> `Chunked MM input disabled but max_tokens_per_mm_item (2496) > max_num_batched_tokens`
> 로 죽습니다. 위 스크립트는 `8192` 로 잡아 안전합니다.

---

## 4. 동작 확인 (서버 로컬에서)

```bash
# 모델 목록 — id 가 gemma-4-26b-a4b 로 떠야 함
curl -s http://localhost:8000/v1/models | python3 -m json.tool

# 채팅 한 방
curl -s http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma-4-26b-a4b","messages":[{"role":"user","content":"한 문장으로 자기소개"}]}' \
  | python3 -m json.tool
```

응답이 오면 서버는 완성입니다. 이제 대시보드에서 붙기만 하면 됩니다.

---

## 5. 네트워크 — 대시보드에서 B 머신에 붙이기

대시보드(Node 서버)가 B 머신의 `:8000` 에 도달해야 합니다. 두 가지 방법:

### 방법 A — 같은 LAN, 직접 IP (운영 기본값)

가장 단순. B 머신 IP를 그대로 씁니다.

```bash
# B 머신에서 IP 확인
hostname -I
```

대시보드 `.env`:
```ini
LP_AI_BASE_URL=http://<B-IP>:8000/v1
```

> ⚠️ **mDNS(`*.local`) 금지:** `overay.local` 같은 이름은 브라우저·PowerShell 에선
> 되지만 **Node 의 fetch/undici 에선 안 풀립니다**(`UND_ERR_CONNECT_TIMEOUT`).
> 그래서 서버측 기본값을 호스트명이 아니라 **IP**로 둡니다.
>
> IP가 재부팅마다 바뀌는 걸 막으려면 **고정 IP**를 주세요 — 라우터 DHCP 예약 또는
> Proxmox cloud-init `ipconfig0`. (현재 `5090native` 도 DHCP라 IP가 바뀌는 이슈가 있음.)

### 방법 B — SSH 터널 (지금 쓰는 방식 / 원격·방화벽 환경)

B 머신 `:8000` 을 열지 않고, 대시보드 호스트에서 SSH 터널로 끌어옵니다.
**대시보드 서버 쪽 localhost:8000 → B 머신 localhost:8000** 으로 매핑:

```bash
# 대시보드가 도는 머신에서 실행 (백그라운드 터널)
ssh -N -L 8000:localhost:8000 user@<B-IP>
```

그러면 대시보드 `.env` 는 localhost 를 가리킵니다:
```ini
LP_AI_BASE_URL=http://127.0.0.1:8000/v1
```

> 터널이 끊기면 AI도 끊깁니다. 상시 운영이면 `autossh` 또는 systemd 서비스로
> 터널을 유지하세요:
> ```bash
> # /etc/systemd/system/gemma4-tunnel.service (대시보드 머신)
> [Service]
> ExecStart=/usr/bin/autossh -M 0 -N -L 8000:localhost:8000 user@<B-IP>
> Restart=always
> ```

---

## 6. launch-pilot 환경변수 연결

`marketingAgent.mjs` 가 읽는 값들입니다 (`.env.example` 참고):

| 변수 | 의미 | 값 예시 |
|------|------|---------|
| `LP_AI_BASE_URL` | OpenAI 호환 엔드포인트(`/v1` 까지) | `http://<B-IP>:8000/v1` |
| `LP_AI_MODEL` | served-model-name 과 **일치해야 함** | `gemma-4-26b-a4b` |
| `LP_AI_API_KEY` | vLLM 은 기본 인증 무시 → **비워둠** | (빈값) |
| `LP_AI_TIMEOUT_MS` | 요청 타임아웃 | `60000` |

```ini
# .env (대시보드)
LP_AI_BASE_URL=http://<B-IP>:8000/v1
LP_AI_MODEL=gemma-4-26b-a4b
LP_AI_API_KEY=
LP_AI_TIMEOUT_MS=60000
```

> Docker 로 대시보드를 띄운다면 `docker-compose.yml` 의 `LP_AI_BASE_URL` 도 같은 값으로.
> (컨테이너 안에서 `127.0.0.1` 은 컨테이너 자신을 가리키니, SSH 터널 방식이면
> `host.docker.internal` 또는 호스트 IP 를 써야 합니다.)

대시보드 재기동 후 연결 확인:
```bash
curl -s http://127.0.0.1:4173/api/ai/status     # AI 서버 상태 라우트
```
UI 에서는 메일 템플릿 관리 모달의 "✨ AI로 초안 생성" 이 동작하면 정상입니다.

---

## 7. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `nvidia-smi` 안 됨 / 모듈 없음 | 커널이 올라가서 595 드라이버 모듈이 깨짐 → 커널 hold(0장 참고), 매칭 모듈 재설치 |
| vLLM 기동 직후 죽음, `max_tokens_per_mm_item (2496) >` | `--max-num-batched-tokens` 가 너무 작음 → `8192` |
| `UND_ERR_CONNECT_TIMEOUT` (대시보드 로그) | `*.local` mDNS 를 Node 가 못 풂 → **IP** 로 교체 |
| `Connection refused` | 서버 미기동(`gemma4.sh status`) 또는 방화벽 → `:8000` 오픈 / SSH 터널 |
| 응답은 오는데 모델 못 찾음(404) | `LP_AI_MODEL` ↔ `--served-model-name` 불일치 |
| OOM / 메모리 부족 | `GPU_MEM_UTIL` 낮추기(0.85) 또는 `--max-model-len` 축소 |
| 짧은 한 줄 번역 품질이 이상 | 알려진 특성 — 26B-A4B 는 한 줄 입력에서 의역/드리프트, 실제 본문 길이에선 정상 |

---

## 8. 요약 체크리스트

- [ ] Blackwell GPU + 595 드라이버, `nvidia-smi` OK, 커널 hold
- [ ] `~/gemma4/.venv` 에 `vllm>=0.20.1`
- [ ] HF 동의 + 토큰으로 `Gemma-4-26B-A4B-NVFP4` 다운로드
- [ ] `gemma4.sh up` → `curl /v1/models` 에 `gemma-4-26b-a4b` 표시
- [ ] 고정 IP(또는 SSH 터널) 확보
- [ ] 대시보드 `.env` 의 `LP_AI_BASE_URL` 을 B 머신으로 변경 → 재기동
- [ ] `/api/ai/status` + UI "✨ AI로 초안 생성" 확인
