# 꼼꼼 README 데모 영상 가이드

## 현재 상태 (2026-10-23, v3 — 전체 기능)

- **영상:** `<video-project>/renders/kkomkkom-intro-v3.mp4` — **85.0초**, 1920×1080, 30fps, H.264, **소리 없음(의도적)**, 3.9MB.
- **포스터:** 같은 폴더의 `kkomkkom-intro-v3-poster.png` — 영상 4초 프레임, 1280×720, 159KB.
- **README 사본:** `docs/assets/kkomkkom-intro-v3.mp4`, `docs/assets/kkomkkom-intro-v3-poster.png`.
- **README 연결:** `DEMO_VIDEO` 블록만 갱신. GitHub는 저장소 안 MP4를 README에서 인라인 재생하지 않으므로 포스터 + MP4 상대 링크로 제공하며, 인라인 재생을 보장하지 않습니다.
- **역할 경계:** README 상단 대표 이미지(hero)는 별도 담당자 소유입니다. 이 문서와 영상은 `DEMO_VIDEO` 블록만 다루며 `docs/assets/kkomkkom-hero.*` 같은 hero 경로를 만들거나 수정하지 않았습니다.
- v2(60초) 자산은 삭제하지 않고 보존했습니다. README 링크만 v3로 교체합니다.
- 화면은 **시연용 예시 데이터**이며 실제 앱 검사 결과가 아닙니다. 화면에 `예시 데이터`를 표시했습니다.

## 구성 (9 scenes / 85s)

| 시간 | 씬 | 화면이 설명하는 기능 |
|---|---|---|
| 0–7s | s1-question | 문제 제기 — AI가 만든 코드를 누가 확인하는가 |
| 7–13s | s2-intro | **①** CLI·MCP, 검사는 읽기 전용, 설정 변경은 별도 보호 명령 |
| 13–23s | s3-routes | **②③** 라우트 발견·GET 관찰, public/protected 정책, exposed/check/locked/unknown, 페이지 스모크, 쓰기 API 정적 분석 |
| 23–31s | s4-secrets | **④** git-tracked `.env`, 하드코딩 키, `NEXT_PUBLIC_*` 이름 신호, `[redacted]` 마스킹과 탐지 범위 한계 |
| 31–42s | s5-build | **⑤⑥** production build JS 무게, 기준선 new/fixed/changed, `--update`/`--fast`, coverage·strict·JSON, exit 0/1/2 |
| 42–53s | s6-artifacts | **⑦** `--artifacts` 정적 검사: source map·민감 파일·클라이언트 비밀 흔적·서버 경계, unsupported/coverage incomplete |
| 53–61s | s7-http | **⑧** opt-in loopback HTTP: 선택 파일 raw bytes 일치, SPA/redirect/404·CDN·프로젝트 신원 미확인, `--fresh` 빌드 부수효과 |
| 61–75s | s8-protect | **⑨** preview → apply+hash → production 검증 → hash-safe restore, private backup·Git 제외·후속 편집 거부·진단 정보 감소·lock 정리 실패 보고·MCP 보호 없음·Windows/macOS 미검증. row02는 `--protect-sourcemaps --apply --expected-hash HASH` 전체 표기, row03은 apply 후 자동 검증(AUTO) |
| 75–85s | s9-close | **⑩①** 5개 언어, 선택 로컬 AI 설명과 외부 agent 호환성 미보장, 로컬 빌드 4단계, npm 미공개 |

## 기능 커버리지 체크리스트

| # | 기능 묶음 | 화면 | 상태 |
|---|---|---|---|
| ① | Next CLI + 읽기 전용 MCP, 로컬 설치(npm 미공개) | S2, S9 | [x] |
| ② | 라우트 발견·GET 관찰, public/protected 정책, unknown | S3 | [x] |
| ③ | 페이지 스모크, 쓰기 메서드별 정적 인증 분석 | S3 | [x] |
| ④ | env/Git/하드코딩 비밀 점검, 출력 마스킹 한계 | S4 | [x] |
| ⑤ | production build JS 무게, 기준선 diff, update/fast | S5 | [x] |
| ⑥ | coverage complete/incomplete, strict exit, JSON | S5 | [x] |
| ⑦ | artifact 정적 검사와 unsupported | S6 | [x] |
| ⑧ | opt-in loopback production HTTP exact bytes | S7 | [x] |
| ⑨ | 보호 preview→apply(hash)→검증→restore와 한계 | S8 | [x] |
| ⑩ | 5개 언어, 선택 로컬 AI 설명 | S9 | [x] |

## 사실 검증

- 명령은 모두 현재 README의 로컬 빌드 기준입니다: `node dist/cli.js ...`. `npx kkomkkom` 설치를 암시하지 않습니다.
- `--artifacts`는 개발 서버·빌드·설치 없이 정적 배포물을 검사하고, `--production-url`은 사용자가 준비한 loopback 서버에 GET만 보냅니다. `--fresh`를 함께 쓰면 먼저 빌드합니다.
- 보호는 명시적 opt-in이며 기본은 미리보기입니다. Git-clean + 승인 hash, private backup, 후속 편집 거부, config-only 복원, lock 정리 실패 별도 보고를 표시했습니다.
- 소스맵 보호를 비밀 보호·역분석 방지·배포 안전 보장으로 표현하지 않았습니다. 브라우저 오류 추적 정보가 줄 수 있음을 표시했습니다.
- `--explain`은 설치된 로컬 AI CLI를 사용하며, 외부 agent 호환성 검증 완료가 아님을 표시했습니다.
- 실제 자격증명·원문 config·민감 digest는 영상에 넣지 않았습니다.

## 검증 결과 (2026-10-23)

- `npm run check` (HyperFrames 0.8.186): **0 error, 11 warning**. 경고는 의도적 무음, 첫 프레임 진입, 작은 보조 라벨(타입 하한)이며 차단 오류가 아닙니다.
- 렌더: `renders/kkomkkom-intro-v3.mp4`, 3.9MB, 1m 47s 소요, screenshot capture(software gpu).
- `ffprobe`: 1920×1080, 30/1 fps, 2550 frames, **85.000000s**, 비디오 스트림만(오디오 없음).
- 대표 프레임: 4s(훅), 10s(소개), 18s(라우트), 27s(비밀정보), 36s(빌드), 47s(배포물), 57s(HTTP), 69s(보호), 80s(언어·시작)을 추출해 텍스트 겹침·잘림·가독성을 확인했습니다.
- S8 명령 조합 수정(검수 지적): row02에 필수 `--protect-sourcemaps`를 포함한 `--protect-sourcemaps --apply --expected-hash HASH` 전체를 표시하고, row03은 실행 명령이 아니라 apply 후 자동 검증(AUTO)임을 명시했습니다. 수정 후 재렌더 4,116,074B, 69s 프레임 (`/tmp/opencode/kk-video-frames/v3/f-69-fixed.png`) 직접 확인. PR #6 merge `254c6ea`, CI `39891611024` success.
- 프레임 0은 배경만 보이는 진입 구간이며, README 포스터는 4초 프레임을 사용합니다. (검사 경고로 기록)
- 기존 `renders/kkomkkom-intro.mp4`(v1), `kkomkkom-intro-v2.mp4`는 덮어쓰지 않았습니다.

## README 반영·확인

- 포스터는 저장소 상대 경로 이미지, 영상은 저장소 상대 경로 링크입니다. 비공개 저장소이므로 접근 권한이 없는 사용자에게 공개 데모처럼 안내하지 않습니다.
- 반영 후 GitHub API의 렌더된 README HTML에서 이미지·링크가 실제로 남아 있는지 확인합니다.
  `gh api repos/hodoi-ing/kkomkkom/readme -H "Accept: application/vnd.github.html"`
- 대용량 편집 원본과 `node_modules`는 소스 저장소에 넣지 않았습니다. 렌더된 MP4(3.9MB)와 포스터(159KB)만 README용으로 포함했습니다.

## 완료 확인

- [x] 10개 기능 묶음 체크리스트와 화면 매핑
- [x] 85초·1920×1080·30fps·무음 유지, 기존 렌더 보존
- [x] `npm run check` 0 error, 대표 프레임 가독성 확인
- [x] 새 MP4·포스터를 별도 이름(v3)으로 렌더
- [x] README `DEMO_VIDEO`를 v3로 갱신하고 PR/CI/main 반영 — PR #5 merge `2238f6c`, CI `39889925302` success, main=local.
- [x] GitHub 렌더 HTML에서 v3 이미지·링크 확인 — `src="docs/assets/kkomkkom-intro-v3-poster.png"`, MP4 링크 보존. raw 자산 인증 200(MP4 4,112,428B, PNG 159,023B).
- [x] 대체 링크 방식 적용 — GitHub 저장소 MP4 인라인 재생은 지원되지 않아 포스터+링크 유지. 브라우저 인라인 재생은 주장하지 않음.
- [x] README 상단 hero 이미지는 w1:pA 소유 — 이 작업에서 생성·수정·경로 예약하지 않음.
