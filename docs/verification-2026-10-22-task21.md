# Issue #2 Task2.1 — 총괄 검수 대기

범위: `issue2/artifacts`의 WIP `3ed9fc4`를 이어 받아, `1b37b28` 위에서 관찰 dedupe 손실만 수정했다. production HTTP/protect는 착수하지 않았다. 원격 push·공개 전환·배포·npm publish·의존성 설치는 하지 않았다.

## 수정과 회귀

- `src/artifacts.ts`의 `add` 기본 key를 `rule:file`에서 `finding.id`로 변경했다. outer inspect의 명시 id와 같은 기준이며, 같은 id의 severity 승격 비교는 그대로다.
- 기존 runtime import 회귀의 assert를 유지하고, 같은 client에서 서로 다른 server target 12개가 모두 남는지 확인했다. 서로 다른 로컬 모듈이 같은 `@prisma/client` target에 닿아도 해당 id는 한 번만 남는다.
- 새 env 회귀는 한 client artifact의 `PRIVATE_TOKEN`·`DB_PASSWORD`·`BACKUP_TOKEN`을 모두 보존한다. 반복 키/값은 중복되지 않고, 서로 다른 키가 같은 값을 가져도 관찰은 유지한다. 값 비노출, warning/uncertain, 공개 env·일반 버전/URL 설정·placeholder 제외를 확인한다.
- README 한/영에 known-value 관찰과 provider 패턴 critical의 구분, runtime import 목록, type-only 제외, module-level server action 경계/모순, 동적 env 미검증, config 1 MiB·1entry 예약을 기록했다.

## 실행 기록

로그 디렉터리: `/tmp/opencode/kk-task21-fix.g09vAI` (새 고유 디렉터리). 모든 테스트에 이 경로를 `TMPDIR`로 전달했다. 출력에 비밀값 원문을 넣지 않았다.

1. 수정 전 RED:

   ```sh
   TMPDIR=/tmp/opencode/kk-task21-fix.g09vAI node --test --test-name-pattern='distinct known env keys|runtime server imports reached' test/artifacts.test.js
   ```

   실제 exit **1**, **0 pass / 2 fail**, `red.log`. env 결과는 첫 키만 남고, runtime import는 `mysql2` 누락으로 실패했다.

2. TypeScript 빌드:

   ```sh
   npm run build
   ```

   실제 exit **0**, `build.log`. 이는 검사기 자체 컴파일이며 사용자 Next 앱 빌드가 아니다.

3. 한 줄 수정 뒤 최초 targeted 실행:

   ```sh
   TMPDIR=/tmp/opencode/kk-task21-fix.g09vAI node --test --test-reporter=tap --test-name-pattern='distinct known env keys|runtime server imports reached' test/artifacts.test.js
   ```

   실제 exit **1**, **1 pass / 1 fail**, `green.log`. target 손실과 env 키 손실 assert는 통과했으나, 새 env fixture에 소스 디렉터리가 없어 `coverage: incomplete/source-missing`였다. 최소 `app/page.tsx` fixture를 추가했고 assert는 완화하지 않았다.

4. Artifact/CLI/MCP focused:

   ```sh
   TMPDIR=/tmp/opencode/kk-task21-fix.g09vAI node --test --test-reporter=tap --test-name-pattern='^(?!(?:a default runtime binding keeps type-only named imports as runtime evidence|a regex literal that looks like a source map directive is not a comment|exception reasons and map targets mask project env secret values)$)' test/artifacts.test.js
   ```

   실제 exit **0**, **42 pass / 0 fail / 0 skipped**, `artifacts.log`. 위 두 RED 회귀도 통과했다. **실행 범위 이탈:** 골든 3건을 제외하려던 negative-only 정규식이 파일 부모 suite에도 매칭되어 3건도 의도치 않게 재실행됐다. 이 실행을 39건으로 축소 보고하지 않으며, 추가 반복 실행하지 않았다.

5. 변경 연결부만 선택한 audit/config/i18n/report/mcp 회귀:

   ```sh
   TMPDIR=/tmp/opencode/kk-task21-fix.g09vAI node --test --test-reporter=tap --test-name-pattern='^env parsing|^redactSecrets|^public API URL|^missing config returns|^invalid JSON|^config read|^every language|^a critical project|^a warning project|^mcp server answers|^invalid tool arguments' test/audit.test.js test/config.test.js test/i18n.test.js test/report.test.js test/mcp.test.js
   ```

   실제 exit **0**, **12 pass / 0 fail / 0 skipped**, `connected.log`. 공유 env 파싱/마스킹·설정 오류·5개 언어 메시지 placeholder·보고서 severity·MCP 스키마/입력 오류 연결을 확인했다. 전체 issue #1 테스트는 반복하지 않았다.

6. `git diff --check`: 실제 exit **0**.

## 남은 검수와 경계

- Task2.1과 단계1은 `[ ]` 유지. 총괄 독립 검수 전 PASS/완료 처리하지 않는다.
- full `npm test`/`npm run verify`, production HTTP, 실제 앱 build/pack 소비자 재실측, protect, Windows/macOS는 이번 범위에서 실행하지 않았다.
- 사용자 지시대로 별도 모델·에이전트·요금제·AI 윤문 CLI를 호출하지 않았다. README는 기술 계약만 직접 수정했으며 patina CLI 검증을 주장하지 않는다.
- 작업 중 발견한 `docs/superpowers/plans/2026-10-22-issue2-artifacts.md`의 별도 Task3 safety contract 변경은 총괄 작업으로 보존하고 이 구현 커밋에서 제외한다.

## 총괄 검수 재작업 — placeholder와 출력 마스킹 분리

총괄이 Task2.1 positive 6건을 직접 통과시킨 뒤, 공통 `searchableEnvValue`의 placeholder 제외가 실제 테스트 환경 자격증명까지 출력 마스킹에서 빼는 회귀를 재현했다. 승인/PASS는 여전히 대기 중이다.

- 공통 마스킹 대상은 기존 계약인 8자 이상·고정 비민감 enum 제외로 복구했다. `PLACEHOLDER` 제외는 `envSensitivePairs`의 finding 탐지에만 적용한다. 새 계층/옵션/의존성은 없다.
- `test`/`dummy`/`your`를 포함한 값마다 audit 1건·artifact 정적 1건·fake build 실패/CLI 오류 출력 1건, 총 9건을 추가했다. `envSecretValues`·`maskSecrets`·`redactSecrets`, artifact exception reason·상대 map target, buildTail·CLI stdout/stderr의 원문 비노출을 검증한다. 해당 값과 공개 env 값은 계속 finding 탐지에서 제외한다.
- build 실패 회귀는 고유 임시 fixture의 가짜 Next 실행 파일만 명시적 `fresh`로 실행한다. 실제 사용자 앱 build/서버/네트워크/설치는 수행하지 않는다.

고유 로그 경로: `/tmp/opencode/kk-task21-mask.U5yLvw`. 테스트에는 이 경로를 `TMPDIR`로 전달했다.

| 순서 | 명령 | 실제 결과 | 로그 |
|---|---|---|---|
| RED | `node --test --test-reporter=tap --test-name-pattern='^masking regression:' test/audit.test.js test/artifacts.test.js` | exit 1, 0 pass / 9 fail. 마스킹 목록 누락, reason/buildTail 마스킹 실패 | `red.log` |
| 검사기 컴파일 | `npm run build` | exit 0 | `build.log` |
| 첫 연결 실행 | `node --test --test-reporter=tap --test-name-pattern='^masking regression:|^every language has every message with no unfilled placeholders$' test/audit.test.js test/artifacts.test.js test/i18n.test.js` | exit 1, 7 pass / 3 fail. i18n 1건은 통과. artifact의 외부 map URL fixture가 이미 `external-target`으로 치환돼 target의 `[redacted]` assert가 실패 | `green.log` |
| 최종 focused | RED와 같은 명령 | exit 0, 9 pass / 0 fail / 0 skipped | `focused.log` |

외부 map URL fixture만 상대 map 경로로 교체해 실제 target 마스킹 경로를 검사했다. assert를 제거/완화하지 않았다. i18n은 첫 연결 실행의 1 pass를 사용하고 다시 실행하지 않았다. 총괄 PASS positive 6건·기존 골든·전체 artifact/audit·full test/verify는 반복하지 않았다. HTTP/protect·push 미착수, Task2.1 `[ ]` 유지. 총괄의 별도 미커밋 Task3 계획은 보존하고 이 수정 커밋에서도 제외한다.

`git diff --check` exit 0. 위 로그 4개에 회귀용 자격증명 원문이 없는지도 별도 assert로 확인했다(exit 0).
