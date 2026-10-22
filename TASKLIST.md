# TASKLIST — kkomkkom

## 현재 작업 — 이슈 #1·#2 (2026-10-22)

사용자 승인: 탭1은 설계·독립 검수·통합, Herdr 탭 `2`는 구현·테스트를 담당한다. 추가 사용자 승인 없이 검수된 변경을 GitHub와 이 로컬 소스에 동일하게 반영한다. 공개 전환·배포는 금지한다. 아래 작업이 과거 `다음` 목록보다 우선한다.

- [x] #1: 설계·회귀 검증 계획 확정 — 2026-10-22 specs/plans 작성, 이슈별 조건·호환성·안전 경계·검증 매핑 자체 검토.
- [x] #1: 서버 바인딩·프로세스 실패/정리 및 입력 검증 수정 — 총괄 독립검수 승인(2026-10-22): 기존 focused 43/43 + de8a6b1 회귀 3/3 직접 통과, mini-app startDevServer→GET /api/health 200→stop→포트 closed(43821) 확인, 원격 main 반영. Windows `taskkill` 실경로와 build SIGINT의 Windows 동작은 미검증.
- [ ] #1: 메서드별 인증 분석·명시적 접근 정책·관찰/판정 분리 — 구현·로컬검증 완료, 총괄 독립검수 대기 (2026-10-22, 탭2 컨텍스트 64%에서 handoff).
  - 구현: `src/classify.ts` TypeScript AST 기반 `analyzeRoute`(App Router export/로컬 alias 메서드별 분석, pages/api `req.method` 비교·switch 분기, 공통가드/불명확 흐름·wrapper/re-export·미호출 nested auth는 `unknown`), `src/probe.ts` GET 전용 관찰과 판정 분리(명시 `protected`+2xx만 `exposed`(빈 204 포함), 명시 `public` 2xx는 `public`, 미지정 2xx는 `check`, 401/403·로그인 리다이렉트 유지), 샘플 파라미터 세그먼트 인코딩(`.`→`%2E`, `/?#` 인코딩)으로 경로/오리진 이탈 방지, `src/audit.ts` 쓰기 경고를 메서드별 `none` 근거로만 발생, `src/types.ts`/`src/baseline.ts` 결과에 method/status/policy/auth 보존, i18n `detailPolicyExposed`/`detailPublic` 5개 언어.
  - 검증: `npm run build` 통과. `node --test test/classify.test.js test/probe.test.js test/audit.test.js test/config.test.js test/i18n.test.js test/baseline.test.js test/report.test.js test/run.test.js` → **94 pass / 0 fail**. Task1 focused 43/43은 총괄 검수로 갈음(재실행 안 함).
  - 의존성/비용 실측(2026-10-22, Linux/WSL, warm npm cache·로컬 tarball): `typescript`를 dependencies로 이동(^5.9.3). pack 42KB, 소비자 설치 0.57s/max RSS 196MB, `node_modules` 23,644KB 중 typescript 23,388KB. cold network 설치·Windows/macOS는 미측정.
  - 남은 항목: 총괄 독립검수(정책 판정 의미, pages 공통가드 unknown, 동적 샘플 인코딩), Task3 coverage/strict/CLI·JSON·MCP 공통 결과 미착수, Task4·5 미착수, 원격 push 금지(Task2 완료 보고 후 총괄 담당).
  - 다음 세션 시작: `cd /home/dev/workspace/next-preflight && git status --short && npm run build && node --test test/classify.test.js test/probe.test.js test/audit.test.js test/config.test.js test/i18n.test.js test/baseline.test.js test/report.test.js test/run.test.js`
  - 주의: untracked `docs/superpowers/specs/2026-10-22-issue2-artifact-protection-design.md`, `docs/superpowers/plans/2026-10-22-issue2-artifacts.md`는 총괄 작업물 — 건드리지 않음.
- [ ] #1: coverage·strict·CLI/JSON/MCP 공통 결과 및 미완료 표시.
- [ ] #1: 크기 측정·기준선 명시적/원자적 갱신·실제 패키지/빌드/MCP 통합 검증.
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
