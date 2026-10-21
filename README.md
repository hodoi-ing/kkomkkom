# 꼼꼼 (kkomkkom)

Next.js 앱을 커밋하기 전에 **안 잠긴 API 문**과 **무거워진 페이지**를 찾아주는 CLI입니다.

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

```bash
npx kkomkkom
```

Node 20 이상. Next.js 프로젝트 루트에서 실행하세요.

## 사용법

```bash
kkomkkom                    # 인증 검사 + 빌드/무게 검사
kkomkkom --fast             # 인증 검사만 (빌드 생략)
kkomkkom --json             # JSON 출력
kkomkkom --explain          # 실패 원인을 로컬 AI CLI로 설명
kkomkkom --port 3100        # 개발 서버 포트 지정
kkomkkom --update           # --fast 결과를 기준선에 반영
kkomkkom --lang ko          # 보고서 언어 (en, ko, ja, zh, es)
kkomkkom --strict           # 경고만 있어도 종료 코드 1
```

종료 코드는 `0` 문제 없음, `1` 배포를 막는 문제(또는 `--strict`에서 경고), `2` 검사 자체가 실패입니다.

결과는 `.kkomkkom/baseline.json`에 저장됩니다. 이 파일을 git에 올리면 팀원도 같은 기준으로 비교합니다.

## 무엇을 보나

**안 잠긴 문**

API 라우트를 로그인 없이 호출합니다. 401/403이면 잠긴 것으로 봅니다. 200이 나오는데 소스에 인증 코드(`auth()`, `getServerSession`, `cookies()` 등)가 있으면 **뚫린 것**으로 판정합니다. 코드에는 잠금장치가 있는데 실제로는 열려 있다는 뜻이라, 미들웨어 우회 같은 사고를 잡습니다.

**무거워진 페이지**

`next build`가 만든 매니페스트에서 라우트별 JS 전송량을 계산해 지난 실행과 비교합니다. 기본 기준은 **+15% 그리고 +30KB**를 동시에 넘을 때입니다.

## 위험 등급과 배포 중단

결과 맨 위에 지금 배포해도 되는지 큰 글씨로 알려줍니다.

| 등급 | 무엇 | 보고서 | 종료 코드 |
|---|---|---|---|
| 🔴 critical | 로그인 없이 열린 API | ⛔ 배포를 멈추세요 | 1 |
| 🟡 warning | 확인이 필요한 API, 서버 오류, 무거워진 페이지 | ⚠️ 배포 전에 확인하세요 | 0 (`--strict`면 1) |
| ⚪ info | 잠긴 문, 공개 목록, 확인 불가 | 목록에만 표시 | 0 |

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

도구 이름은 `kkomkkom`이고, `projectPath`, `fast`, `strict`, `lang`을 받습니다.

## 커밋 전에 자동으로 돌리기

```yaml
# .github/workflows/kkomkkom.yml
- run: npx kkomkkom --fast --strict
```

안 잠긴 API가 있으면 종료 코드가 1이라 워크플로가 실패합니다. `--strict`를 붙이면 경고도 실패로 봅니다.

## 안전 규칙

- GET만 보냅니다. POST/PUT/PATCH/DELETE는 데이터를 지울 수 있어 보내지 않습니다.
- 쿠키와 인증 헤더를 보내지 않습니다.
- `localhost`만 검사합니다.
- 우리가 띄운 개발 서버만 종료합니다.

## 한계

- Next.js 전용입니다.
- 동적 라우트(`[id]`)는 `kkomkkom.config.json`의 `sampleParams`에 값을 넣어야 검사합니다.
- 인증 판정은 소스 코드의 신호를 봅니다. 간접적인 인증은 놓칠 수 있습니다.
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
npm test          # 빌드 + 단위 테스트
npm run verify    # 빌드 + 단위 테스트 + 실제 Next 앱 e2e (수동 확인 없이 한 번에)
npm run build
node dist/cli.js --port 3199 --fast   # fixtures/mini-app 에서
```

## 라이선스

MIT
