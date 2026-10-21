# TASKLIST — kkomkkom

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
- [x] v1.3: 단위 테스트 82개 + `npm run verify` 17개 통과

## 다음

- [ ] GPT 세션에 최종 diff 독립 검증 요청
- [ ] push 후 GitHub Actions (Node 20/22/24 + e2e) 확인
- [ ] v1.1: TTFB 측정 (초 단위 체감 속도)
- [ ] npm 배포 — 보류 (사용자 결정: 저장소 비공개 유지, 2026-10-21)
- [ ] 데모 GIF

## 작업 규칙

- 2회 이상 같은 문제로 막히거나 원인을 못 찾으면 herdr 스킬로 GPT 세션 탭에 해당 부분만 넘기고, 수정 결과를 받아 이어간다.
- `[x]`는 검증 완료로 간주하고 파일 재확인에 시간을 쓰지 않는다.
