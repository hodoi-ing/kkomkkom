<div align="center">

# 🐯 꼼꼼 <sub>kkomkkom</sub>

**Next.js 앱을 커밋하기 전에, 실제로 불러서 찾아보는 문제들.**

`안 잠긴 API` · `새어 나가는 비밀키` · `깨진 페이지` · `인증 없는 쓰기 API` · `무거워진 페이지`

<a href="https://github.com/hodoi-ing/kkomkkom/actions/workflows/test.yml"><img src="https://github.com/hodoi-ing/kkomkkom/actions/workflows/test.yml/badge.svg" alt="test" /></a>
<a href="https://img.shields.io/badge/license-MIT-2f6f4f.svg"><img src="https://img.shields.io/badge/license-MIT-2f6f4f.svg" alt="MIT License" /></a>
<a href="https://img.shields.io/badge/node-%3E%3D20-5FA04E.svg"><img src="https://img.shields.io/badge/node-%3E%3D20-5FA04E.svg" alt="Node 20+" /></a>
<a href="https://img.shields.io/badge/Next.js-000000?logo=next.js"><img src="https://img.shields.io/badge/Next.js-000000?logo=next.js" alt="Next.js" /></a>
<a href="https://img.shields.io/badge/npm-%EB%8B%9C%ED%8A%B8-lightgrey"><img src="https://img.shields.io/badge/npm-%EB%8B%9C%ED%8A%B8-lightgrey" alt="npm unpublished" /></a>

</div>

---

## 왜 필요한가

AI가 짠 코드는 검증을 건너뛰면 그대로 배포됩니다. 그런데 지금까지 쓰던 검증은 두 가지뿐이었습니다.

- **눈으로 읽는 코드 리뷰** — 라우트가 열려 있는지 소스에서 찾아 읽습니다. 놓치기 쉽습니다.
- **AI에게 다시 물어보기** — "이거 안전해?"라고 물으면 그럴듯한 답이 돌아옵니다. 근거는 없습니다.

꼼꼼은 질문 대신 **직접 부릅니다**. 라우트를 실제로 GET하고, 응답 코드를 확인하고, 번들 크기를 비교합니다.

| | AI에게 다시 묻기 | 꼼꼼 |
|---|---|---|
| 근거 | 그럴듯한 답변 | 실제 HTTP 응답 |
| 열린 API | 소스에서 추측 | 로그인 없이 호출해 확인 |
| 페이지 무게 | 감으로 짐작 | 지난 실행과 전송량 비교 |
| 비밀키 | 파일을 훑어봄 | git에 올라갔는지, 패턴으로 판정 |
| 결과 | 확신 없음 | 종료 코드와 기준선 파일 |

---

## 무엇을 찾는가

| 검사 | 찾는 것 | 기준 |
|---|---|---|
| **안 잠긴 API 문** | 로그인 없이 열리는 라우트 | 401/403이면 잠김, 200인데 인증 코드가 있으면 **뚫린 것** |
| **새어 나가는 비밀키** | git에 올라간 `.env`, 소스에 박힌 키, `NEXT_PUBLIC_`에 들어간 시크릿 | `.env` 커밋·고신뢰 패턴은 **critical** |
| **깨진 페이지** | 빌드는 통과하지만 실제로는 500인 화면 | 로그인 없이 GET으로 열어 확인 |
| **인증 없는 쓰기 API** | `POST`·`PUT`·`PATCH`·`DELETE`인데 인증 신호가 없는 라우트 | 소스만 읽습니다. **쓰기 요청은 보내지 않습니다** |
| **무거워진 페이지** | 지난 실행보다 커진 라우트 | +15% **그리고** +30KB를 동시에 넘을 때 |

코드에는 잠금장치가 있는데 실제로는 열려 있는 경우가 가장 위험합니다. 미들웨어 우회 같은 사고가 여기에 걸립니다.

---

## 미리보기

```
$ kkomkkom --fast

⛔ 배포를 멈추세요 — 문제 2개가 있습니다.

🔴 새로 뚫린 문 2개
  /api/users        로그인 없이 데이터가 그대로 나옵니다 (200)
  /api/orders/123   로그인 없이 데이터가 그대로 나옵니다 (200)

🐢 무거워진 페이지 1개
  /checkout   180KB → 420KB (+240KB, +133%)
```

결과는 맨 위에 큰 글씨로 나옵니다. 배포해도 되는지 눈으로 먼저 판단하게 만드는 게 목적입니다.

---

## 설치

아직 npm에 공개하지 않았습니다. 저장소를 받아서 씁니다.

```bash
git clone https://github.com/hodoi-ing/kkomkkom.git
cd kkomkkom
npm install
npm run build
npm link          # 이 컴퓨터에서 kkomkkom 명령 사용
```

- Node 20 이상
- 검사할 Next.js 프로젝트 루트에서 실행합니다
- npm에 공개하면 `npx kkomkkom` 한 줄로 끝납니다

---

## 사용법

```bash
kkomkkom                    # API 인증·비밀키·페이지 오류·쓰기 API + 빌드/무게 검사
kkomkkom --fast             # 빌드만 생략 (나머지 검사는 모두 실행)
kkomkkom --json             # JSON 출력
kkomkkom --explain          # 실패 원인을 로컬 AI CLI로 설명
kkomkkom --update           # --fast 결과를 기준선에 반영
kkomkkom --port 3100        # 개발 서버 포트 지정
kkomkkom --reuse            # 이미 실행 중인 Next 서버 재사용
kkomkkom --lang ko          # 보고서 언어 (en, ko, ja, zh, es)
kkomkkom --strict           # 경고만 있어도 종료 코드 1
```

| 옵션 | 하는 일 |
|---|---|
| `--fast` | `next build`만 건너뜁니다. 나머지 검사는 그대로 돕니다. CI에서 자주 씁니다. |
| `--json` | 기계가 읽는 JSON으로 출력합니다. `diff`에 더해 `extra` 배열(비밀키·페이지·쓰기 API)이 붙습니다. |
| `--explain` | 설치된 AI CLI를 찾아 실패 원인을 설명해 줍니다. `claude`, `codex`, `gemini` 순서로 찾습니다. |
| `--update` | 이번 `--fast` 결과를 기준선으로 저장합니다. 무게 비교의 출발점을 갱신하는 용도입니다. |
| `--port` | 검사할 개발 서버 포트를 지정합니다. |
| `--reuse` | 이미 떠 있는 서버를 씁니다. **같은 프로젝트인지 확인하지 않습니다.** |
| `--lang` | 보고서 언어를 고릅니다. `--lang` > `KKOMKKOM_LANG` > `LC_ALL` > `LANG` 순으로 적용됩니다. |
| `--strict` | 경고도 실패로 봅니다. 종료 코드 1이 나옵니다. |

### 종료 코드

| 코드 | 의미 |
|---|---|
| `0` | 문제 없음 (경고만 있고 `--strict`가 없을 때도 0) |
| `1` | 배포를 막는 문제 — API 노출, 비밀키 노출, 빌드 실패, `--strict` 경고 |
| `2` | 검사를 시작하거나 끝내지 못함 — 프로젝트·포트·설정 오류 |

### 기준선

결과는 `.kkomkkom/baseline.json`에 저장됩니다. 이 파일을 git에 올리면 팀원도 같은 기준으로 비교합니다.

```json
{
  "id": "kkomkkom-baseline",
  "version": 1,
  "routes": { "/checkout": { "jsBytes": 420000 } }
}
```

---

## 위험 등급

| 등급 | 무엇 | 보고서 | 종료 코드 |
|---|---|---|---|
| 🔴 critical | 로그인 없이 열린 API, git에 올라간 `.env`, 소스에 박힌 비밀키 | ⛔ 배포를 멈추세요 | 1 |
| 🟡 warning | 확인이 필요한 API, 서버 오류, 인증 없는 쓰기 API, 페이지 오류, 무거워진 페이지 | ⚠️ 배포 전에 확인하세요 | 0 (`--strict`면 1) |
| ⚪ info | 잠긴 문, 공개 목록, 확인 불가, 페이지 타임아웃 | 목록에만 표시 | 0 |

---

## 안전한 검사 규칙

검사 도구가 프로젝트에 요청을 보낸다는 사실 자체가 리스크입니다. 그래서 다음은 지킵니다.

- **GET만 보냅니다.** `POST`·`PUT`·`PATCH`·`DELETE`는 데이터를 지울 수 있어 보내지 않습니다. 쓰기 API는 소스만 읽습니다.
- **쿠키와 인증 헤더를 보내지 않습니다.** 로그인 없는 상태 그대로 호출합니다.
- **localhost만 검사합니다.**
- **우리가 띄운 개발 서버만 종료합니다.**
- **비밀값은 가립니다.** 보고서, JSON, AI 설명 프롬프트, 빌드 로그에서 `[redacted]`로 바꿉니다. 파일 이름과 줄 번호만 알려줍니다.
- **리다이렉트 주소를 보여줄 때 쿼리스트링과 프래그먼트를 뺍니다.** `?token=...` 같은 값이 결과에 남지 않습니다.

---

## CI에 붙이기

```yaml
# .github/workflows/kkomkkom.yml
- run: npx kkomkkom --fast --strict
```

npm 공개 전이라면 저장소 경로의 CLI를 직접 실행하세요.

```yaml
- run: node ./path/to/kkomkkom/dist/cli.js --fast --strict
```

API 노출이나 비밀키 노출이 있으면 종료 코드가 1이라 워크플로가 실패합니다.

---

## MCP로 붙이기

Claude Code, Cursor 같은 에이전트가 검사를 직접 호출하게 할 수 있습니다.

```json
{
  "mcpServers": {
    "kkomkkom": {
      "command": "npx",
      "args": ["-y", "-p", "kkomkkom", "kkomkkom-mcp"]
    }
  }
}
```

도구 이름은 `kkomkkom`이고 `projectPath`, `fast`, `strict`, `reuse`, `lang`을 받습니다.

---

## 설정

프로젝트 루트에 `kkomkkom.config.json`을 두면 됩니다.

```json
{
  "ignoreRoutes": ["/api/health", "/api/webhooks/*"],
  "sampleParams": { "/api/orders/[id]": { "id": "1" } },
  "port": 3100,
  "thresholds": { "jsPercent": 15, "jsBytes": 30000 }
}
```

| 키 | 기본값 | 하는 일 |
|---|---|---|
| `ignoreRoutes` | `[]` | 검사에서 빼는 경로. 웹훅이나 헬스체크 같은 게 흔합니다. |
| `sampleParams` | `{}` | 동적 라우트에 넣을 값. `"/api/orders/[id]": { "id": "1" }` |
| `port` | 자동 | 개발 서버 포트. |
| `thresholds` | `+15%`, `+30KB` | 무게 증가 기준. 둘 다 넘을 때 경고로 봅니다. |

---

## 한계

- **Next.js 전용입니다.**
- 동적 라우트(`[id]`)는 `sampleParams`에 값을 넣어야 검사합니다.
- 인증 판정은 소스 코드의 신호를 봅니다. 간접적인 인증이나 미들웨어 인증은 놓칠 수 있습니다.
- 주석 제거는 가벼운 자체 렉서를 씁니다. 아주 특이한 정규식이나 메서드 표기에서는 인증·쓰기 판정이 틀릴 수 있으니, 경고가 나오면 코드를 한 번 직접 확인하세요.
- 비밀키 검사는 프로젝트 루트의 `.env*` 파일과 주요 소스 폴더만 봅니다. 하위 폴더의 `.env`는 검사하지 않습니다.
- 빌드 실패 로그의 비밀값 가림은 `.env*`에서 읽은 8자 이상 값과 정해진 키 패턴만 대상으로 합니다. 그 밖의 셸 환경변수는 가리지 못할 수 있습니다.
- `NEXT_PUBLIC_` 검사는 이름만 보고 판단합니다. 실제로 공개해도 되는 값이면 경고를 무시해도 됩니다.
- 페이지 스모크는 8초 안에 응답이 없으면 타임아웃으로 표시합니다. 첫 컴파일이 느린 개발 서버에서는 타임아웃이 날 수 있습니다.
- v1은 초 단위 체감 속도를 재지 않습니다. 전송량은 정확하지만 화면 렌더 시간은 아닙니다.

---

## 자주 묻는 질문

**AI에게 물어보는 것과 뭐가 다른가요?**
물어보면 그럴듯한 답을 받습니다. 꼼꼼은 라우트를 실제로 부르고 응답 코드를 봅니다. 답이 아니라 증거입니다.

**서버를 띄워도 되나요?**
포트가 비어 있으면 직접 띄우고, 우리가 띄운 서버만 종료합니다. 이미 떠 있는 서버를 쓰려면 `--reuse`를 명시해야 합니다.

**비밀키 값이 보고서에 나오나요?**
나오지 않습니다. `[redacted]`로 가리고 파일 이름과 줄 번호만 알려줍니다.

**Next.js가 아니면 어떻게 되나요?**
다른 프레임워크 프로젝트면 unsupported로 끝납니다. Next.js만 다룹니다.

---

## 개발

```bash
npm install
npm test          # 빌드 + 단위 테스트 89개
npm run verify    # 빌드 + 단위 테스트 + 실제 Next 앱 e2e 17개
npm run build
node dist/cli.js --port 3199 --fast   # fixtures/mini-app 에서
```

push할 때마다 GitHub Actions가 단위 테스트(Node 20·22·24)와 실제 앱 e2e를 자동으로 돌립니다.

---

## 라이선스

MIT

---

<details>
<summary><b>English</b></summary>

**kkomkkom** — a pre-commit checkup for Next.js apps. It finds API routes that answer without authentication, secrets that leaked into git, pages that return 500, write APIs without auth, and routes that got heavier than the last run.

```bash
git clone https://github.com/hodoi-ing/kkomkkom.git
cd kkomkkom && npm install && npm run build && npm link
kkomkkom --fast
```

Exit codes: `0` clean, `1` deploy-blocking problem, `2` the check could not run. Results are saved to `.kkomkkom/baseline.json` — commit it so the whole team compares against the same baseline.

Safety: GET requests only, no cookies or auth headers, localhost only, secrets redacted as `[redacted]`.

Next.js only. MIT licensed.

</details>
