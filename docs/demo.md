# 꼼꼼 README 데모 영상 가이드

## 현재 상태 (2026-11-11, v4 — 웹 UI 추가)

- **영상:** `docs/assets/kkomkkom-intro-v4.mp4` — **94.0초**, 1920×1080, 30fps, H.264, **소리 없음(의도적)**, 4.3MB.
- **포스터:** `docs/assets/kkomkkom-intro-v4-poster.png` — 79.5초(웹 UI 씬) 프레임, 1280×720, 155KB.
- **README 연결:** `DEMO_VIDEO` 블록만 갱신. GitHub는 저장소 안 MP4를 README에서 인라인 재생하지 않으므로 포스터 + MP4 상대 링크로 제공하며, 인라인 재생을 보장하지 않습니다.
- v2(60초)·v3(85초) 자산은 삭제하지 않고 보존했습니다. README 링크만 v4로 교체합니다.
- 화면은 **시연용 예시 데이터**이며 실제 앱 검사 결과가 아닙니다.

## 구성 (10 scenes / 94s)

| 시간 | 씬 | 화면이 설명하는 기능 |
|---|---|---|
| 0–7s | s1-question | 문제 제기 — AI가 만든 코드를 누가 확인하는가 |
| 7–13s | s2-intro | **①** CLI·MCP, 검사는 읽기 전용, 설정 변경은 별도 보호 명령 |
| 13–23s | s3-routes | **②③** 라우트 발견·GET 관찰, public/protected 정책, exposed/check/locked/unknown, 페이지 스모크, 쓰기 API 정적 분석 |
| 23–31s | s4-secrets | **④** git-tracked `.env`, 하드코딩 키, `NEXT_PUBLIC_*` 이름 신호, `[redacted]` 마스킹과 탐지 범위 한계 |
| 31–42s | s5-build | **⑤⑥** production build JS 무게, 기준선 new/fixed/changed, `--update`/`--fast`, coverage·strict·JSON, exit 0/1/2 |
| 42–53s | s6-artifacts | **⑦** `--artifacts` 정적 검사: source map·민감 파일·클라이언트 비밀 흔적·서버 경계, unsupported/coverage incomplete |
| 53–61s | s7-http | **⑧** opt-in loopback HTTP: 선택 파일 raw bytes 일치, SPA/redirect/404·CDN·프로젝트 신원 미확인, `--fresh` 빌드 부수효과 |
| 61–75s | s8-protect | **⑨** preview → apply+hash → production 검증 → hash-safe restore와 한계 (MCP 보호 없음, Windows/macOS 미검증) |
| 75–84s | s10-web | **⑪** 로컬 웹 UI: 프로젝트 선택 → 검사 → 판정 문장, 같은 규칙 한 묶음, 누르면 고치는 순서 |
| 84–94s | s9-close | **⑩①** 5개 언어, 선택 로컬 AI 설명, 로컬 빌드 4단계 |

## 기능 커버리지 체크리스트

| # | 기능 묶음 | 화면 | 상태 |
|---|---|---|---|
| ① | Next CLI + 읽기 전용 MCP, 로컬 설치 | S2, S9 | [x] |
| ② | 라우트 발견·GET 관찰, public/protected 정책, unknown | S3 | [x] |
| ③ | 페이지 스모크, 쓰기 메서드별 정적 인증 분석 | S3 | [x] |
| ④ | env/Git/하드코딩 비밀 점검, 출력 마스킹 한계 | S4 | [x] |
| ⑤ | production build JS 무게, 기준선 diff, update/fast | S5 | [x] |
| ⑥ | coverage complete/incomplete, strict exit, JSON | S5 | [x] |
| ⑦ | artifact 정적 검사와 unsupported | S6 | [x] |
| ⑧ | opt-in loopback production HTTP exact bytes | S7 | [x] |
| ⑨ | 보호 preview→apply(hash)→검증→restore와 한계 | S8 | [x] |
| ⑩ | 5개 언어, 선택 로컬 AI 설명 | S9 | [x] |
| ⑪ | 로컬 웹 UI — 판정 문장·묶음 표시·상세 안내 | S10 | [x] |

## 제작 기록

- HyperFrames 프로젝트(별도 비공개 작업 디렉터리)에서 `npx hyperframes render`로 렌더. 이 저장소에는 결과물만 둔다.
- v4에서 추가된 씬은 `s10-web`. 웹 UI가 제공하는 판정·묶음·상세 안내를 3개 포인트와 목업 화면으로 보여준다.
- 렌더 검사: `hyperframes check` 0 error (경고 12건은 기존 씬의 작은 라벨 크기 관련).
