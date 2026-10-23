# 배포 준비 점검 — 2026-10-23

| 게이트 | 현재 근거 |
|---|---|
| 기본 배포물 검사·명시적 local production HTTP | Task2/2.1/3 총괄 승인. Task3 snapshot의 Node20/22/24 + e2e CI 성공: [39878058305](https://github.com/hodoi-ing/kkomkkom/actions/runs/39878058305) |
| 보호 preview/apply/restore·실패 복원 | Task4 구현, 독립 리뷰 지적 수정, focused·실제 Next/packed 검증 기록 확보. [독립 검수](review-2026-10-23-task4.md), [구현 기록](verification-2026-10-23-task4.md) |
| 마지막 수정·최종 통합 | 코드 `c6f9009`의 선택 로드 신규 회귀까지 총괄 직접 PASS. 최종 HEAD CI·main 동기화는 아직 완료 전 |
| 실제 공개·배포 | 수행하지 않음. 저장소 비공개·npm 미공개 유지 |

## 요구사항과 검증 근거

| 이슈 #2 범위 | 구현·판정 | 근거 |
|---|---|---|
| A 소스맵 | 설정·실제 파일·참조·inline map·비공개 서버 산출물·실제 파일 바이트 제공을 구분 | [Task3](verification-2026-10-22-task3.md) 및 기존 Task2 승인 기록 |
| B 배포 파일 | public/.next/static 경계에서 파일명 의심과 내용·HTTP 관찰을 분리. 저장소 테스트만으로 경고하지 않음 | Task2 승인, Task3 실통합·raw byte/SPA/redirect/404 회귀 |
| C 클라이언트 정보 | provider 패턴과 env-known 값의 등급 구분, 제한된 AST import/server-action 경계, 출력 경로까지 마스킹 | [Task2.1](verification-2026-10-22-task21.md), Task3 메타데이터 보안 회귀 |
| D 미지원·누락 | 기본 출력만 검증, 누락·예산·오류·동적 해석 불가를 coverage에 표시. 기존 fast 의미 유지 | Task2/3 승인, strict/CLI/MCP 연결 검증 |
| 선택 보호 | literal true→false만 변경, Git/hash 승인, private byte-exact backup, 후속 변경 거부, config-only rollback·정리 실패 분리 | Task4 focused·실제 repo/packed CLI, SIGINT/TERM·lock/metadata/backup 경계 회귀 |
| 비용 | 동일 fixture/cache 기준 static/HTTP/fresh·pack/설치 관측. 단발 warm-cache 수치를 보편적 성능 보장으로 쓰지 않음 | [측정 기록](measurements-2026-10-22.md) |
| CLI/CI/MCP | 공유 inspection schemaVersion 2/coverage/0·1·2. 보호 JSON은 별도 작업 결과이고 MCP는 보호 인자를 거부 | Task3/4 실제 정상·입력 오류·설정 오류·스트림 생존 검증 |
| 후속 확장 | 후보 평가 완료와 플랫폼 구현 보류를 구분 | [확장 평가](extension-assessment-2026-10-23.md) |

## 로컬 사용 순서

아래 경로는 실제 로컬 경로로 바꾼다. 설치 준비는 registry에 접근할 수 있다. 현재 비공개 저장소 접근 권한이 필요하며 `npx` 공개 배포를 전제로 하지 않는다.

```sh
cd /path/to/kkomkkom
npm ci
npm run build
cd /path/to/target-next-app
node /path/to/kkomkkom/dist/cli.js --artifacts --strict --json
```

| 작업 | 명시 명령·조건 |
|---|---|
| 기존 배포물만 검사 | `--artifacts --strict --json`. 서버·build·AI·패키지 설치 없음 |
| 새 production 산출물 검사 | `--artifacts --fresh --strict --json`. 선택한 프로젝트 build가 `.next` 등 산출물을 생성할 수 있음 |
| 실제 파일 제공 확인 | 실제 `next start` 서버를 먼저 준비한 뒤 `--artifacts --production-url http://127.0.0.1:PORT --strict --json`. 외부 서버·인증·redirect 추적 없음 |
| 보호 미리보기 | `--protect-sourcemaps --json`. token/위치·승인 hash·영향·부수효과를 확인. absent/false는 no-op |
| 보호 적용 | `--protect-sourcemaps --apply --expected-hash HASH --json`. 같은 프로젝트의 현재 preview hash를 직접 승인. tracked Git-clean 대상만 변경 |
| 복원 | `--restore TRANSACTION_ID --json`. 현재 적용 hash/mode 및 활성 transaction이 맞아야 함. 사용자 후속 편집은 덮어쓰지 않음 |
| CI 개발 검증 준비 | README의 root/fixture `npm ci` 및 TypeScript cache 준비 후 `npm run verify`. 준비 단계의 registry 접근과 offline packed 소비자 검증을 구분 |

## 실패·복원 확인표

| 결과·상황 | 확인·대응 |
|---|---|
| 일반 검사 exit 0 | 경고가 없어졌다는 보장은 아님. 자동 게이트는 `--strict`와 coverage를 함께 확인 |
| 일반 검사 exit 1 / 2 | 차단 조건 / 실행·입력·설정 오류를 구분. 값 없는 rule/file/evidence/coverage를 보존하고 원인을 해결 |
| 보호 작업 실패 | `status`, `exitCode`, `configChanged`, `verification`, `rollback`, `rollbackFailureReason`, `lockCleanup`, `lockCleanupFailureReason`을 따로 확인 |
| lock 정리 failed/unconfirmed | 검증이나 서버 cleanup 성공과 구분. 다른 작업·교체된 lock·권한 원인을 확인하고, 남의 lock을 자동 삭제하거나 무조건 chmod하지 않음 |
| restore가 후속 변경을 거부 | 현재 파일을 보존. private 원본과의 수동 비교·병합이 필요하며 강제 덮어쓰기로 해결하지 않음 |
| 전원 차단·SIGKILL 뒤 lock/active 잔존 | 실행 중인 소유 프로세스가 없는지 먼저 확인. 현재 설정·원본 backup·metadata·mode의 일치를 비공개로 대조한 뒤 해당 상태 파일만 별도 보존해 수동 정리. 저장소 전체 삭제·임의 stale-lock 삭제 금지 |
| restore rename 뒤 active 정리 전 중단 | 설정이 이미 원본일 수 있음. 반복 apply/restore가 거부되면 위 조건 확인 후 잔존 상태만 수동 복구. config가 복원됐다는 이유로 `.next`도 복원됐다고 보지 않음 |
| backup·metadata | 인증정보가 있을 수 있으므로 private 유지·공유/`git add -f` 금지. transaction 내부는 자동 ignore. 비밀 없는 active/lock까지 일반 staging에서 제외하려면 프로젝트 소유자가 protection 저장소 전체 ignore를 선택 |
| config 복원 완료 | 생성 build 산출물은 복원되지 않음. 다음 배포 전 원하는 설정으로 다시 build·검증 |

## 지원·보장 경계

| 항목 | 확인 범위 |
|---|---|
| 실제 앱 환경 | Linux/WSL, Next 16.4.2, 로컬 Node26.10.0. Node20/22/24는 명시한 원격 CI revision의 결과만 인정 |
| 보호 AST | 단일 직접 object export의 JS/MJS/CJS/TS literal. wrapper·간접 export·실행형 top-level·spread/computed/중복·복수 config는 미지원 |
| 다른 출력·플랫폼 | custom distDir/export/standalone/모노레포, Windows/macOS 실제 앱·디렉터리 내구성, 모바일·Electron 미검증/미지원 범위를 문서대로 유지 |
| 서버·공개 범위 | loopback에서 선택한 파일과 응답의 일치만 확인. 프로젝트 동일성·인터넷 배포·전체 취약점 부재를 보장하지 않음 |
| 실행 경계 | 프로젝트 build/config는 자체 네트워크·파일 작업을 할 수 있음. `CI=1`과 loopback 제한은 임의 프로젝트 코드 sandbox가 아님 |
| 내구성·경합 | fsync 순서와 hash-safe 복원 검증. 실제 정전·동일 권한 외부 프로세스와 최종 확인/rename 사이의 OS transaction 보장 없음 |
| MCP 클라이언트 | 서버 공통 자동 검증과 설정 예제 제공. 에이전트별 실제 설치·연결 검증은 보류 유지 |

## 오탐·부분 검증 보고

| 포함할 정보 | 제외할 정보 |
|---|---|
| 꼼꼼/Node/Next 버전, OS, 명령의 옵션, rule ID, 가린 상대 파일 경로, evidenceKind·confidence·coverage, 기대한 공개 정책 | `.env` 원문, 인증 header/cookie, 실제 token, private backup·metadata 원본, 개인 절대 경로 |
| 예: 의도적으로 공개한 map의 `artifact-source-map` 관찰과 비공개 업로드 위치 구분이 잘못됐는지, 정확한 rule/file/reason 예외가 coverage에 남는지 | 이름에 secret이 있다는 이유만으로 실제 비밀값을 첨부하거나 운영 자격증명으로 재현하지 않음 |
