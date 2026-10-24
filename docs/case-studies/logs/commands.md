# 검증 명령과 환경 (익명 공개판)

> **공개 정책:** 이 문서는 도구 측정값과 비식별 분류만 기록한다. 개별 보안 판정과 근거는 내부 원본에만 보존하며, 공개판은 취약점 확정이나 대상 식별 자료가 아니다.

작업 디렉터리는 저장소 밖의 `$WORK`로 표기한다. 모든 설치는 `$WORK/home`을 `HOME`으로 써서 사용자 전역 캐시와 분리했다. `CI=1`, `NEXT_TELEMETRY_DISABLED=1`을 공통으로 두었다. 실제 대상 이름·주소·커밋·고유 경로가 담긴 정확한 명령은 내부 자료에만 있다.

## 환경

| 항목 | 값 |
|---|---|
| 실행일 | 2026-10-23 |
| 플랫폼 | Linux (WSL2) |
| CPU/RAM | 12 vCPU / 5 GiB (swap 4 GiB) |
| Node | v20.20.2, v22.23.2, v26.10.0 (nvm) |
| npm | 10.8.2 (Node 20), 10.9.8 (Node 22), 12.1.0 (Node 26) |
| pnpm | 9.15.9 (corepack) |
| Yarn | 3.6.1 (저장소에 vendoring) |
| 검사 도구 | `kkomkkom` 0.1.0 |

## 공통

```bash
WORK=/path/to/isolated/work
export HOME="$WORK/home"
export CI=1
export NEXT_TELEMETRY_DISABLED=1

git clone --depth 1 <repo-url> "$WORK/projects/<case>"
git -C "$WORK/projects/<case>" rev-parse HEAD   # 내부 기록용
```

`kkomkkom`은 저장소의 빌드 산출물을 직접 실행했다.

```bash
node /path/to/kkomkkom/dist/cli.js --json
node /path/to/kkomkkom/dist/cli.js --fast --json
node /path/to/kkomkkom/dist/cli.js --artifacts --strict --json
```

- 전체 검사는 프로덕션 빌드를 다시 수행하고 페이지 무게를 측정한다.
- `--fast`는 빌드를 건너뛰고 라우트·페이지 스모크·정적 분석만 수행한다.
- `--artifacts`는 `.next` 정적 산출물을 검사한다. `--strict`는 경고/미완료 시 종료 코드 1을 낸다.

## 설치 정책

- npm은 `npm ci --ignore-scripts --no-audit --no-fund`, pnpm은 `--frozen-lockfile --ignore-scripts`, Yarn 3은 `--immutable --mode=skip-build`를 우선했다.
- 설치 스크립트가 필요할 수 있는 사례가 있었지만, **사전 검토 기록은 보존되어 있지 않으며 충분성은 검증되지 않았다.**
- `npm ci --ignore-scripts`는 프로젝트의 `npm run build` 자체 안전성을 입증하지 않는다.
- 전역 설치, `npm install -g`, 저장소 설정 변경은 하지 않았다.

## 후속 검증 (B)

Node 22.23.2를 명시한 새 셸에서 실행했다.

```bash
source /path/to/nvm/nvm.sh
nvm use 22.23.2
export HOME="$WORK/home"
export CI=1
export NEXT_TELEMETRY_DISABLED=1
cd "$WORK/projects/b"

# 범위 축소: 스트림·프록시 계열 4개 패턴을 ignoreRoutes로 제외 (정확한 패턴은 내부)
node /path/to/kkomkkom/dist/cli.js --update --json     # 기준선 생성
node /path/to/kkomkkom/dist/cli.js --json              # 무변경 비교

# 합성 클라이언트 증가: 결정적 500,000자 문자열을 클라이언트 컴포넌트에서 런타임 참조
# 외부 의존성/외부 호출 없음. 합성 실험이며 실제 취약점/전송량/성능 회귀 아님.
node /path/to/kkomkkom/dist/cli.js --json

# 인증 HTTP: loopback 서버 + 임시 비밀번호(메모리만, 원문 비출력)
# 17검사 중 16통과, 1추가검토(근거 내부). 외부 검색/게시/쓰기 없음.
python3 "$WORK/logs/auth-check.py"
```

인증 검증은 인증 관련 원문을 출력·저장하지 않았다. 개별 보안 판정은 공개하지 않는다.

## 원본 로그

원본 JSON·time 로그는 저장소 밖 내부 자료에만 있다. 공개 디렉터리에는 정제된 `results.json`, `followup-b.json`과 이 문서만 둔다. 원본 클론·`node_modules`·`.next`는 보고서 확정 후 삭제했다.
