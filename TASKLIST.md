# TASKLIST — kkomkkom

## 현재 작업 — 이슈 #1·#2 (2026-10-22)

사용자 승인: 탭1은 설계·독립 검수·통합, Herdr 탭 `2`는 구현·테스트를 담당한다. 추가 사용자 승인 없이 검수된 변경을 GitHub와 이 로컬 소스에 동일하게 반영한다. 공개 전환·배포는 금지한다. 아래 작업이 과거 `다음` 목록보다 우선한다.

- [x] #1: 설계·회귀 검증 계획 확정 — 2026-10-22 specs/plans 작성, 이슈별 조건·호환성·안전 경계·검증 매핑 자체 검토.
- [x] #1: 서버 바인딩·프로세스 실패/정리 및 입력 검증 수정 — 총괄 독립검수 승인(2026-10-22): 기존 focused 43/43 + de8a6b1 회귀 3/3 직접 통과, mini-app startDevServer→GET /api/health 200→stop→포트 closed(43821) 확인, 원격 main 반영. Windows `taskkill` 실경로와 build SIGINT의 Windows 동작은 미검증.
- [x] #1: 메서드별 인증 분석·명시적 접근 정책·관찰/판정 분리 — 총괄 PASS(2026-10-22): `e567b00` Task2/3 재작업을 독립 108/108 회귀+코드검토로 확인. 총괄 PASS 전 [x] 금지 규칙에 따라 이 항목만 [x].
  - 구현: `src/classify.ts` TypeScript AST 기반 `analyzeRoute`(App Router export/로컬 alias 메서드별 분석, pages/api `req.method` 비교·switch 분기, 공통가드/불명확 흐름·wrapper/re-export·미호출 nested auth는 `unknown`), `src/probe.ts` GET 전용 관찰과 판정 분리(명시 `protected`+2xx만 `exposed`(빈 204 포함), 명시 `public` 2xx는 `public`, 미지정 2xx는 `check`, 401/403·로그인 리다이렉트 유지), 샘플 파라미터 세그먼트 인코딩(`.`→`%2E`, `/?#` 인코딩)으로 경로/오리진 이탈 방지, `src/audit.ts` 쓰기 경고를 메서드별 `none` 근거로만 발생, `src/types.ts`/`src/baseline.ts` 결과에 method/status/policy/auth 보존, i18n `detailPolicyExposed`/`detailPublic` 5개 언어.
  - 검증: `npm run build` 통과. `node --test test/classify.test.js test/probe.test.js test/audit.test.js test/config.test.js test/i18n.test.js test/baseline.test.js test/report.test.js test/run.test.js` → **94 pass / 0 fail**. Task1 focused 43/43은 총괄 검수로 갈음(재실행 안 함).
  - 의존성/비용 실측(2026-10-22, Linux/WSL, warm npm cache·로컬 tarball): `typescript`를 dependencies로 이동(^5.9.3). pack 42KB, 소비자 설치 0.57s/max RSS 196MB, `node_modules` 23,644KB 중 typescript 23,388KB. cold network 설치·Windows/macOS는 미측정.
  - 총괄 지적 수정(2026-10-22, `76e68a9`): ① 공용 `params.ts`가 `.`/`..` 세그먼트·미치환·optional/catchall을 거부하고 API/페이지 모두 HTTP 요청 0으로 unknown 처리, ② `auditWrites`가 명시 public을 경고하지 않고 메서드별 `write-no-auth:<path>:<method>`·미확인 `write-unknown` 근거를 유지, ③ `discoverRoutes`가 router를 명시해 `app/api/pages/route.ts` 오판 회귀, ④ 미사용 `hasAuthSignal`/`classify`/자체 렉서 제거. 신규 회귀 포함 144 pass.
  - 총괄 지적 5개 수정(`e567b00`): ① ignored/skipped(의도적 fast·ignore·정적 GET 없는 405)와 failed/unsupported 구분, unknown 쓰기 분석은 명시 public만 static-only, ② 본문 전송 실패를 failed/unknown으로 보존하고 `readBody`가 남은 바이트만 보존·전송 오류 reject, ③ app/pages 쓰기 테스트 루프 분리, ④ 빈/undefined 샘플 값은 요청 0회로 거부, ⑤ pages 분기 미해석은 `unsupported` coverage+info finding.
  - 남은 항목: Task4는 총괄 독립검수 PASS(17개 직접통과+수정 코드 검토, 2026-10-22). Task5는 총괄 지적 4건 수정 후 최종 verify·PASS 대기. 원격 push 금지(총괄 담당).
  - 다음 세션: `git status --short`로 미커밋 보존 확인. Task5 [x]는 총괄 PASS 후에만.
  - 주의: issue2 문서 2개는 총괄이 `e9eea72`로 커밋했고 작업 브랜치 원격 snapshot도 총괄이 저장함. 건드리지 않음.
- [x] #1: coverage·strict·CLI/JSON/MCP 공통 결과 및 미완료 표시 — 총괄 PASS(2026-10-22). build/secrets aggregate 보완은 코드 검토+새 회귀로 확인했으며 재실행하지 않음. 아래 세부 기록 유지.
  - 보완(2026-10-22, 탭2): `summarizeCoverage`가 build/secrets의 failed·unsupported도 모든 rule에서 `incomplete`에 반영하도록 수정. route 검사가 0개면 `empty` 유지, fast/ignore는 계속 비차단. Task4 측정 실패도 같은 coverage를 사용. run 신규 회귀 3개 포함 focused 66/66.
  - 구현: `CoverageCheck`(checked/static-only/ignored/skipped/failed/unsupported + reason)와 `CoverageSummary`(complete/incomplete/empty)를 run 엔진에서 계산. API GET·페이지 스모크·쓰기 정적분석·secrets·build를 모두 기록하고 fast/build 실패/405/전부 제외/유의미 0을 구분. 일반 실행은 incomplete여도 exit 0, strict는 incomplete/경고 시 1, 도구 오류는 기존 2. JSON `schemaVersion: 2`+`coverage`, MCP `structuredContent` 동일 결과. HTTP 본문은 공용 `readBody`가 바이트 상한에서 읽기를 중단·취소. MCP tools/call은 단일 큐로 직렬화.
  - 검증(`e567b00`): `npm test` exit 0, 155 pass / 0 fail (`/tmp/kk-task23-full.HY0Zct.log`). `npm run verify` exit 0, unit 155 + real app e2e 전체 통과 (`/tmp/kk-task23-verify.3psmGO.log`).
- [x] #1: 크기 측정·기준선 명시적/원자적 갱신·실제 패키지/빌드/MCP 통합 검증 — 총괄 독립검수 PASS(2026-10-22). 17개 직접통과+수정 코드 검토, 재실행 없음. 아래 세부 기록 유지.
  - 구현(`src/build.ts`): B/kB/MB를 1/1000/1000000으로 환산하고 단위 대소문자 허용. 0바이트 chunk는 실측 0으로 유지. 누락/읽기권한/디렉터리 chunk는 `MeasurementError(missing|read|directory)`로 실패하며 runBuild `measure` 실패→coverage `build:failed/measure`. 중복 chunk는 `/_next/` 접두어를 정규화해 한 번만 합산. Next 표 측정은 `method: next-output`, manifest 합산은 `method: manifest-file`로 기록.
  - 구현(`src/baseline.ts`): ENOENT만 기준선 없음으로 처리하고 읽기 실패는 `errBaselineRead`, JSON/형상/verdict/비음수 유한 수치/method 오류는 원본 무변경 `errBaseline`. 기준선과 현재 측정 모두 method가 기록되어 있고 같을 때만 delta/heavy를 계산하며, method 없는 legacy baseline은 읽기만 하고 비교하지 않음(마이그레이션 안내). `--update`만 `.baseline.lock` 배타 lock + 고유 임시파일+rename으로 원자 저장하며 fast update는 기존 page weight를 보존. lock은 자동 stale 삭제 없이 제한 대기 후 명시 오류, 자기 소유 lock만 해제. 저장 전 형상 검증.
  - 구현(`src/run.ts`): 일반/최초 검사는 기준선을 쓰지 않음. 명시 `--update`는 검사 완료(`complete`)일 때만 저장하고 필수 누락·빌드 실패·측정 실패·empty/incomplete는 `errUpdateRefused`로 원본 보존. 노출/경고 finding은 저장을 막지 않으며 exitCode 1은 유지.
  - 검증(2026-10-22, 탭2): 실패 회귀를 먼저 실행해 exit 1(신규 23개 실패, `/tmp/kk-task4.WVz9k0/red2.log`). 구현 후 `npm run build` exit 0, `node --test test/build.test.js test/baseline.test.js test/run.test.js test/mcp.test.js` 66/66 pass exit 0(`/tmp/kk-task4.WVz9k0/green2.log`), `node --test test/i18n.test.js test/report.test.js` 15/15 pass exit 0(`/tmp/kk-task4.WVz9k0/connected.log`), 최종 연결 6파일 `build/baseline/run/mcp/i18n/report` 81/81 pass exit 0(`/tmp/kk-task4.WVz9k0/final.log`). CLI `--json` 손상 baseline exit 2, MCP tools/call 오류 응답·스트림 생존 확인.
  - 총괄 재현 3건 수정(2026-10-22, 별도 commit): `bb9b75b` legacy/미기록 method는 비교 금지+`--update` 안내(신규 회귀 red→green), `a3c0666` 살아있는/오래된 lock 자동 삭제 금지+자기 소유 lock만 해제+생성 실패 정리(lock 보존·제한 대기 회귀), `9df2244` 발견 페이지별 측정 누락 cross-check→`build failed/measure`+strict 1+update 거부·원본 보존(전체/부분 누락, API-only 비발명 회귀). 수정 후 연결 6파일 87/87 pass exit 0.
  - 제한: Windows/macOS 미검증. MCP에는 update 인자가 없어 원자 갱신 검증은 CLI/엔진 경로에서만 수행.
- [ ] #1: Task5 production build·MCP·pack 소비자·문서 정합성 — 총괄 지적 4건 수정·최종 verify 완료, PASS 대기(미승인).
  - 구현/검증: `scripts/verify.mjs`에 실제 `next build`(비 fast)·매니페스트 실측·`--update` 후 byte-identical 재검사·소스 digest 불변, MCP `tools/call` 정상/입력/비 Next/설정 오류와 스트림 생존, npm pack 소비자(production deps만) CLI/MCP 검증 추가. 실측 `/`·`/checkout` 568,618B `manifest-file`. `--reuse` 신원 미확인을 `coverage server/unsupported`로 기록. CLI help·MCP 스키마 설명·README의 기준선/update/port/schema/coverage/측정/local MCP 예시·Windows/macOS 미검증 문구 정합화. 전체 로그·명령·exit code: `docs/verification-2026-10-22.md`, `docs/verification-logs/`.
  - 총괄 지적 4건 수정(2026-10-22): ① `ENOENT`와 읽기 실패를 구분해 unreadable source file/dir/`.env`를 `secrets failed/read`로 기록(기존 source 계속 검사, 값 비노출, strict 1, update 거부·baseline 보존), ② unreadable 필수 API source/dir는 `errSourceRead` 도구 오류(exit 2)로 처리, ③ 400·408·429 등 미확인 4xx를 `api-auth failed/http-<status>`로 기록해 strict 1·통과 배너 차단(405 GET-less 예외 유지), ④ README의 `manifest-file`(비압축 파일 합)과 `next-output`(해당 Next 버전 보고값, 실제 전송량 보장 없음) 구분. 회귀 6건 red→green, focused 117/117.
  - 최종 통합: `npm run verify` exit 0, 197 unit/regression + production/MCP/pack e2e, tarball 52,950B·설치 558ms(로컬 캐시). 로그 `docs/verification-logs/2026-10-22-npm-verify.txt`. `npm test`는 verify에 포함되어 별도 실행하지 않음.
- [ ] #1: 총괄 독립 검수·필요한 재작업·GitHub 반영 및 로컬 동기화.
- [ ] #2 단계 0: 설치 크기·시간·메모리·네트워크 실측 기준선 및 계약 정리.
- [ ] #2 단계 1: Next production 배포물 점검 설계·구현·검수 (소스맵/배포 파일/클라이언트 비밀정보/지원 범위).
- [ ] #2 단계 2: production 산출물·opt-in 로컬 운영 서버·경계 사례·소비자 CLI/MCP 검증과 비용 비교.
- [ ] #2 단계 3: 제한된 Next 보호 변경의 미리보기·선택 적용·복원·재검증 설계 및 구현/검수.
- [ ] #2 단계 4: 후속 확장 수요/비용 평가 기록 — 난독화·Electron·모바일 구현은 후속 후보로 유지.
- [ ] 최종 검수 결과·이슈별 완료/보류/한계 기록, GitHub main과 로컬 HEAD 일치 확인.

에이전트별 실제 연결 검증은 #2의 보류 결정을 유지한다. MCP 자체 tools/call 자동 검증은 수행한다. 구현자는 검수 전 원격 push/main 반영하지 않는다.

## 완료

- [x] GitHub 비공개 저장소 생성 및 이름 변경 (`hodoi-ing/kkomkkom`) — 2026-10-21
- [x] 설계 문서 작성 `docs/superpowers/specs/2026-10-21-kkomkkom-design.md`
- [x] 구현 계획 작성 `docs/superpowers/plans/2026-10-21-kkomkkom.md`
- [x] 라우트 탐색 (app/pages 라우터) + 테스트
- [x] 인증 판정 규칙 (`locked`/`exposed`/`check`/`unknown`/`error`) + 테스트
- [x] 개발 서버 기동/재사용/종료 + API 호출 (GET 전용, 쿠키 없음)
- [x] 기준선 저장·비교 (`new`/`fixed`/`same`/`changed`)
- [x] Next 16 매니페스트 기반 페이지 무게 계산 + 구버전 출력 파서 폴백
- [x] CLI (`--fast`, `--json`, `--update`, `--port`, `--explain`, `--help`)
- [x] fixtures/mini-app 실제 실행 검증 (뚫림/막힘/무거움/종료 코드)
- [x] 테스트 27개 통과, README/License, main 푸시
- [x] v1.1: 실패 증거를 로컬 에이전트 CLI(`claude -p`, `codex exec`, `gemini -p`)로 설명
- [x] v1.1: MCP 서버 노출 (`kkomkkom-mcp`)
- [x] GitHub Actions 테스트 워크플로
- [x] v1.2: 위험 등급(critical/warning/info) + "배포를 멈추세요" 배너 + `--strict` 종료 코드
- [x] v1.2: 다국어 보고서 (en/ko/ja/zh/es) + `--lang`, 환경변수 자동 감지, AI 설명도 같은 언어
- [x] v1.2: 테스트 39개 통과, 실제 fixture에서 ja/zh/ko + strict 종료 코드 검증
- [x] 자동 검증: `npm run verify` (빌드 + 단위 테스트 43개 + 실제 Next 앱 e2e) + CI e2e 잡
- [x] GPT 세션 독립 검증 1차: FAIL, 7건 발견 → 3xx 오판·서버 재사용·src 라우트·빌드 청크·첫 --update·노출 목록 수정
- [x] GPT 세션 독립 검증 2차: 남은 1건(로그인 리다이렉트 판정) 수정 — 목적지가 실제 로그인 화면(비밀번호 폼/401/403)인지 확인
- [x] GPT 세션 독립 검증 3차: 상대 경로 Location을 요청 URL 기준으로 해석하도록 수정
- [x] v1.3: 비밀키 점검 (git에 올라간 `.env`, `.gitignore` 누락, `NEXT_PUBLIC_` 비밀 이름, 소스 하드코딩 키)
- [x] v1.3: 페이지 스모크 (5xx·Next 오류 화면, 8초 타임아웃, GET 전용)
- [x] v1.3: 쓰기 API 인증 점검 (POST/PUT/PATCH/DELETE 정적 신호, 실제 요청 없음)
- [x] v1.3: GPT 세션이 별도 worktree에서 `src/audit.ts` + 테스트 35개 구현, main에 병합
- [x] v1.3: 보고서·종료 코드·JSON `extra`·MCP·`--explain` 통합
- [x] v1.3: 단위 테스트 85개 + `npm run verify` 17개 통과
- [x] GPT 최종 검증 FAIL 4건 수정: 빌드/개발 로그 비밀값 가림, 리다이렉트 쿼리 제거, 주석 오판, --fast 문구
- [x] GPT 재검증 FAIL 2건 수정: PEM 개인키 블록 전체 마스킹, 정규식 리터럴이 주석 처리를 깨는 문제
- [x] GPT 재재검증 FAIL 1건 수정: 화살표 함수(`=>`)·제어문 뒤 정규식 리터럴, 메서드 호출 뒤 나눗셈/공백·주석 경계 오판 방지
- [x] 수정 후 단위 테스트 89개 + `npm run verify` 17개 재통과

## 다음

- [x] GPT 세션 최종 독립 검증 PASS — `f507fdc`, npm test 89/89, `npm run verify` 17/17, CLI 경계 39개
- [x] push 후 GitHub Actions (Node 20/22/24 + e2e) 확인 — run 39607570850 성공
- [ ] v1.1: TTFB 측정 (초 단위 체감 속도)
- [ ] npm 배포 — 보류 (사용자 결정: 저장소 비공개 유지, 2026-10-21)
- [ ] 데모 GIF

## 작업 규칙

- 2회 이상 같은 문제로 막히거나 원인을 못 찾으면 herdr 스킬로 GPT 세션 탭에 해당 부분만 넘기고, 수정 결과를 받아 이어간다.
- `[x]`는 검증 완료로 간주하고 파일 재확인에 시간을 쓰지 않는다.
