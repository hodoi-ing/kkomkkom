# 꼼꼼 (kkomkkom)

Next.js 앱을 커밋하기 전에 **안 잠긴 API 문**, **새어 나가는 비밀키**, **깨진 페이지**, **인증 없는 쓰기 API**, **무거워진 페이지**를 찾아주는 CLI입니다.

AI가 만든 코드가 진짜 도는지 AI에게 다시 묻는 대신, 실제로 호출해서 증거를 봅니다.

```
꼼꼼 — 커밋 전 점검

⛔ 배포를 멈추세요 — 문제 2개가 있습니다.

🔴 새로 뚫린 문 2개
  /api/users        로그인 없이 데이터가 그대로 나옵니다 (200)
  /api/orders/123   로그인 없이 데이터가 그대로 나옵니다 (200)

🐢 무거워진 페이지 1개
  /checkout   180KB → 420KB (+240KB, +133%)
```

## 설치

아직 npm에 공개하지 않았습니다. 지금은 저장소를 받아서 씁니다.

```bash
git clone https://github.com/hodoi-ing/kkomkkom.git
cd kkomkkom
npm install
npm run build
npm link          # 이 컴퓨터에서 kkomkkom 명령 사용
```

Node 20 이상. 검사할 Next.js 프로젝트 루트에서 실행하세요. npm에 공개한 뒤에는 `npx kkomkkom` 한 줄로 설치할 수 있습니다.

## 사용법

```bash
kkomkkom                    # API 인증·비밀키·페이지 오류·쓰기 API + 빌드/무게 검사
kkomkkom --fast             # 빌드만 생략 (나머지 검사는 모두 실행)
kkomkkom --json             # JSON 출력
kkomkkom --explain          # 실패 원인을 로컬 AI CLI로 설명
kkomkkom --port 3100        # 개발 서버 포트 지정
kkomkkom --reuse            # 이미 실행 중인 Next 서버 재사용
kkomkkom --update           # --fast 결과를 기준선에 반영
kkomkkom --lang ko          # 보고서 언어 (en, ko, ja, zh, es)
kkomkkom --strict           # 경고만 있어도 종료 코드 1
```

종료 코드는 `0` 문제 없음, `1` 배포를 막는 문제(API 노출·비밀키 노출·빌드 실패·`--strict` 경고), `2` 검사를 시작하거나 끝내지 못함(프로젝트·포트·설정 오류)입니다.

결과는 `.kkomkkom/baseline.json`에 저장됩니다. 이 파일을 git에 올리면 팀원도 같은 기준으로 비교합니다.

`--json` 출력에는 기존 `diff`와 함께 `extra` 배열이 들어갑니다. 비밀키·페이지·쓰기 API 검사 결과이며, 각 항목은 `id`, `severity`, `message`를 가집니다.

## 무엇을 보나

**안 잠긴 문**

API 라우트를 로그인 없이 호출합니다. 401/403이면 잠긴 것으로 봅니다. 200이 나오는데 소스에 인증 코드(`auth()`, `getServerSession`, `cookies()` 등)가 있으면 **뚫린 것**으로 판정합니다. 코드에는 잠금장치가 있는데 실제로는 열려 있다는 뜻이라, 미들웨어 우회 같은 사고를 잡습니다.

**비밀키**

- `.env`, `.env.local` 같은 파일이 git에 올라가 있으면 **critical**입니다. 파일을 지우고 키를 교체해야 합니다.
- `.env` 파일이 `.gitignore`에 없으면 **warning**입니다. 실수로 커밋될 수 있습니다.
- `NEXT_PUBLIC_` 이름에 `SECRET`, `TOKEN`, `PASSWORD` 같은 단어가 있으면 **warning**입니다. `NEXT_PUBLIC_` 값은 브라우저로 전송됩니다.
- 소스에 `sk_live_`, `sk-proj-`, `AKIA`, `ghp_`, `xoxb-`, 개인키 블록처럼 비밀키로 보이는 값이 있으면 **critical**입니다.

비밀값 자체는 보고서나 JSON에 절대 출력하지 않습니다. `.env.example`, `.env.sample`, `.env.template`은 검사에서 뺍니다.

**깨진 페이지**

빌드가 통과해도 실제 페이지가 500으로 터지거나 Next 오류 화면을 보여줄 수 있습니다. 발견된 페이지를 로그인 없이 GET으로 열어 확인합니다. 3xx/4xx는 로그인·데이터 없음일 수 있어 건너뜁니다.

**쓰기 API 인증**

`POST`, `PUT`, `PATCH`, `DELETE`를 처리하는 API 라우트 소스에 `auth()`, `getServerSession`, `cookies()` 같은 인증 신호가 없으면 **warning**입니다. 미들웨어에서 인증하는 경우도 있으니 경고를 보고 확인하세요. 실제 쓰기 요청은 절대 보내지 않습니다.

**무거워진 페이지**

`next build`가 만든 매니페스트에서 라우트별 JS 전송량을 계산해 지난 실행과 비교합니다. 기본 기준은 **+15% 그리고 +30KB**를 동시에 넘을 때입니다.

## 위험 등급과 배포 중단

결과 맨 위에 지금 배포해도 되는지 큰 글씨로 알려줍니다.

| 등급 | 무엇 | 보고서 | 종료 코드 |
|---|---|---|---|
| 🔴 critical | 로그인 없이 열린 API, git에 올라간 `.env`, 소스에 박힌 비밀키 | ⛔ 배포를 멈추세요 | 1 |
| 🟡 warning | 확인이 필요한 API, 서버 오류, 인증 없는 쓰기 API, 페이지 오류, 무거워진 페이지 | ⚠️ 배포 전에 확인하세요 | 0 (`--strict`면 1) |
| ⚪ info | 잠긴 문, 공개 목록, 확인 불가, 페이지 타임아웃 | 목록에만 표시 | 0 |

```
⛔ 배포를 멈추세요 — 문제 1개가 있습니다.

🔴 뚫린 문 1개
  /api/leak  로그인 없이 데이터가 그대로 나옵니다 (200)
```

CI에서 경고도 막고 싶으면 `kkomkkom --fast --strict`를 쓰세요.

## 언어

보고서는 영어·한국어·일본어·중국어·스페인어로 나옵니다.

```bash
kkomkkom --lang ja
KKOMKKOM_LANG=es kkomkkom
```

`--lang` > `KKOMKKOM_LANG` > `LC_ALL` > `LANG` 순서로 고르고, 아무것도 없으면 영어입니다. AI 설명(`--explain`)도 같은 언어로 요청합니다.

## AI가 원인을 설명해주게 하기

`--explain`을 붙이면 설치된 AI CLI를 찾아 실패 원인을 설명합니다.

```bash
kkomkkom --explain
kkomkkom --explain --explain-with claude
```

`claude`, `codex`, `gemini` 순서로 찾습니다. 구독만 있으면 API 키 없이 동작합니다. 아무것도 없으면 붙여넣기용 프롬프트를 출력합니다.

## MCP로 붙이기

Claude Code, Cursor 같은 에이전트가 직접 검사를 호출하게 할 수 있습니다.

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

도구 이름은 `kkomkkom`이고, `projectPath`, `fast`, `strict`, `reuse`, `lang`을 받습니다.

## 커밋 전에 자동으로 돌리기

```yaml
# .github/workflows/kkomkkom.yml
- run: npx kkomkkom --fast --strict
```

안 잠긴 API나 비밀키 노출이 있으면 종료 코드가 1이라 워크플로가 실패합니다. `--strict`를 붙이면 경고도 실패로 봅니다.

## 안전 규칙

- GET만 보냅니다. POST/PUT/PATCH/DELETE는 데이터를 지울 수 있어 보내지 않습니다. 쓰기 API는 소스만 읽습니다.
- 쿠키와 인증 헤더를 보내지 않습니다.
- `localhost`만 검사합니다.
- 우리가 띄운 개발 서버만 종료합니다.
- 포트가 비어 있으면 직접 서버를 띄웁니다. 이미 떠 있는 서버를 쓰려면 `--reuse`를 명시해야 하며, 이때 그 서버가 같은 프로젝트인지 확인하지는 않습니다. 다른 프로젝트의 서버라면 결과가 틀릴 수 있습니다.
- 리다이렉트(3xx)는 같은 주소의 페이지만 따라가서 확인합니다. 비밀번호 입력 폼이 있는 로그인 화면이면 잠김, 아니면 확인이 필요한 경고입니다. 외부 주소로 가는 리다이렉트는 따라가지 않고 경고로 표시합니다.
- 비밀키 검사에서 찾은 값과 고신뢰 키 패턴은 보고서, JSON, AI 설명 프롬프트, 빌드/개발 로그에서 `[redacted]`로 가립니다. 파일 이름과 줄 번호만 알려줍니다. 다만 `.env`에 없는 임의의 셸 환경변수 값까지 모두 가릴 수는 없습니다.
- 리다이렉트 주소를 보여줄 때 쿼리스트링과 프래그먼트는 뺍니다. `?token=...` 같은 값이 보고서나 JSON에 들어가지 않습니다.

## 한계

- Next.js 전용입니다.
- 동적 라우트(`[id]`)는 `kkomkkom.config.json`의 `sampleParams`에 값을 넣어야 검사합니다.
- 인증 판정은 소스 코드의 신호를 봅니다. 간접적인 인증이나 미들웨어 인증은 놓칠 수 있습니다.
- 주석 제거는 가벼운 자체 렉서를 씁니다. 아주 특이한 정규식이나 메서드 표기에서는 인증·쓰기 판정이 틀릴 수 있으니, 경고가 나오면 코드를 한 번 직접 확인하세요.
- 비밀키 검사는 프로젝트 루트의 `.env*` 파일과 주요 소스 폴더만 봅니다. 하위 폴더의 `.env`는 검사하지 않습니다.
- 빌드 실패 로그의 비밀값 가림은 `.env*`에서 읽은 8자 이상 값과 정해진 키 패턴만 대상으로 합니다. 그 밖의 셸 환경변수는 가리지 못할 수 있습니다.
- `NEXT_PUBLIC_` 검사는 이름만 보고 판단합니다. 실제로 공개해도 되는 값이면 경고를 무시해도 됩니다.
- 페이지 스모크는 8초 안에 응답이 없으면 타임아웃으로 표시합니다. 첫 컴파일이 느린 개발 서버에서는 타임아웃이 날 수 있습니다.
- v1은 초 단위 체감 속도를 재지 않습니다. 전송량은 정확하지만 화면 렌더 시간은 아닙니다.

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

## 개발

```bash
npm install
npm test          # 빌드 + 단위 테스트 89개
npm run verify    # 빌드 + 단위 테스트 + 실제 Next 앱 e2e 17개 (수동 확인 없이 한 번에)
npm run build
node dist/cli.js --port 3199 --fast   # fixtures/mini-app 에서
```

push할 때마다 GitHub Actions가 단위 테스트(Node 20·22·24)와 실제 앱 e2e를 자동으로 돌립니다.

## 라이선스

MIT
