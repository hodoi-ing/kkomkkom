# Task4 독립 검수 — 2026-10-23

| 항목 | 근거 |
|---|---|
| 읽기 전용 독립 리뷰 | GPT-6.1 Sol medium, `5666c4d..fc97342`. 기존 #1·Task2/Task3 완료 검사는 재실행하지 않음 |
| 범위 | AST preview, tracked Git/hash 승인, private backup/metadata/active ownership, 경계·동시성, rollback/finalization, owned production 종료, CLI/MCP 계약 |
| 사용자 프로젝트 변경 | 없음. 적용·복원은 새 임시 Git fixture에만 수행 |
| 현재 게이트 | 아래 수정의 독립 focused/실통합 통과. 선택 시에만 보호 모듈을 로드하는 마지막 연결 회귀와 최종 원격 CI는 별도 확인 |

## 재현된 지적과 처리

| 등급·문제 | 실제 영향 | 처리·근거 |
|---|---|---|
| Important: owned lock 삭제 실패 은폐 | build가 protection 디렉터리를 `0500`으로 바꾸면 작업은 exit 0인데 lock이 남고 복원이 막힘 | `5bd79b8`: `lockCleanup`의 passed/failed/unconfirmed 및 사유를 분리하고 non-success로 반환. 검증·rollback·transaction/설정 변경 결과 보존. 남의 lock·읽을 수 없는 lock 강제 삭제 없음 |
| Minor: hidden executable-mode 변경 | assume-unchanged 뒤 chmod하면 blob만 비교하는 clean guard를 우회. 권한 변경 자체는 보존됐음 | 명시한 Git-clean 계약에 맞춰 같은 수정에서 보완. HEAD/index/worktree executable mode를 비교하되 `core.filemode=false` 존중. assume-unchanged/skip-worktree 회귀 포함 |
| 사전 확인: private backup의 실수 staging | 권한이 private여도 일반 `git add -A`에 원본·metadata가 포함될 수 있음 | `d0002f7`: 새 owned transaction 안에 ignore 파일을 원본 저장 전에 생성·동기화. 기존 프로젝트 ignore/전역 설정 불변. 일반 staging 제외·강제 추가 위험 안내 |

재현: `/tmp/opencode/task4-review.ajolrYh6/repro.cjs`. 총괄이 실코드와 호출부를 확인한 뒤 수정 지시했다. 추가 리뷰어 재호출 대신 RED→GREEN 회귀와 독립 실행 결과로 수정 여부를 판정했다.

## 총괄 직접 실행

코드 기준: `5bd79b8`. 고유 실행 경로: `/tmp/opencode/kk-task4-coordinator.cdlaoe_w/`.

| 명령 | 실제 결과 | 보존 로그 |
|---|---|---|
| `node --test test/protect.test.js test/protect-cli.test.js test/protect-verification.test.js` | exit 0, **32 pass / 0 fail** | [focused](verification-logs/2026-10-23-task4-coordinator-focused.txt) |
| `NEXT_TELEMETRY_DISABLED=1 node scripts/verify.mjs --protect-only` | exit 0, 실제 Next browser maps → repo/packed CLI 적용·owned production·맵 제거 확인·후속 편집 거부·byte-exact 복원·MCP 쓰기 거부 | [실통합](verification-logs/2026-10-23-task4-coordinator-protect-scoped.txt) |

두 명령 모두 `TMPDIR`에 위 고유 경로를 사용했다. 보존 로그는 원본과 byte-identical 비교를 통과했다. scoped 실행의 pack 92,800 B·offline 소비자 설치 538 ms는 해당 실행 관측이며 새 통제 비용 benchmark가 아니다. full suite와 Task3 골든은 별도 반복하지 않았다.

## 검증 경계

| 검토 시 유보한 항목 | 최종 판정 기준 |
|---|---|
| 기존 #1·Task2/Task3 완료 검사 | 기존 승인과 커밋된 검증 기록 신뢰. Task4가 바꾼 연결부만 독립 실행 |
| full Task4/실제 Next/packed 검증 | 위 총괄 실행 및 구현자의 291회귀/통합 기록. 최종 수정 HEAD의 전체 CI 결과는 별도 기록 |
| Windows/macOS·전원 차단 내구성 | 미검증 유지. Linux/WSL 임시 fixture·fsync 호출 순서를 다른 OS나 실제 정전 검증으로 표현하지 않음 |
| 다른 Next 버전의 내부 자동 설치·컴파일러 fallback | 설치된 Next 16.4.2 경로만 실제 관측. `CI=1`은 임의 프로젝트 build 코드의 네트워크/파일 작업을 막는 sandbox가 아님 |
| 백업 staging 보호 | 알려진 보완으로 포함하고 위 focused 검증에서 직접 확인. 플랫폼 구현 완료와 혼동하지 않음 |

관련 문서: [구현·RED/GREEN 기록](verification-2026-10-23-task4.md), [승인 계획](superpowers/plans/2026-10-22-issue2-artifacts.md), [후속 확장 평가](extension-assessment-2026-10-23.md).
