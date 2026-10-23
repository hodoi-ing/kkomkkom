# 꼼꼼 README 데모 영상 가이드

## 현재 상태 (2026-10-23)

- **영상:** `/home/hodol/workspace/videos/kkomkkom-video/renders/kkomkkom-intro-v2.mp4` — 60.0초, 1920×1080, 30fps, H.264, **소리 없음(의도적)**.
- **포스터:** 같은 폴더의 `kkomkkom-intro-v2-poster.png` — 영상 4초 프레임, 1280×720.
- **README 사본:** `docs/assets/kkomkkom-intro-v2.mp4`, `docs/assets/kkomkkom-intro-v2-poster.png`.
- **README 연결:** 상단 `DEMO_VIDEO` 위치에 포스터 이미지 + MP4 상대 링크. GitHub는 저장소 안 MP4를 README에서 인라인 재생하지 않으므로, 저장소 접근 권한이 있는 사용자가 링크를 눌러 브라우저에서 열거나 내려받는 방식입니다. 인라인 재생을 보장하지 않습니다.
- 화면은 **시연용 예시 데이터**이며 실제 앱 검사 결과가 아닙니다. 영상과 README 모두에 표시했습니다.
- 기존 렌더 `renders/kkomkkom-intro.mp4`와 스타일 테스트 자산은 덮어쓰지 않았습니다.

## 구성 (7 scenes / 60s)

| 시간 | 화면 | 전달하는 내용 |
|---|---|---|
| 0–7s | 에디토리얼 | “AI가 만든 코드, 진짜인지는 누가 확인하나요?” |
| 7–13s | 에디토리얼 | CLI·MCP 정의. 검사는 읽기 전용, 설정 변경은 별도 보호 명령 |
| 13–24s | 에디토리얼 | 검사 6종: API 인증·비밀정보·페이지 오류·쓰기 API·JS 크기·배포물/소스맵 |
| 24–34s | 터미널 | `--artifacts` 정적 검사 + 선택적 `--production-url` 로컬 HTTP. raw bytes 일치와 미확인 항목을 분리 |
| 34–42s | 터미널 | 추측 vs 증거: GET만, loopback만, 파일명이 아니라 바이트, 비밀값 가림 |
| 42–52s | 에디토리얼 | 선택형 보호 4단계: preview → apply + hash → production 검증 → hash-safe restore. 적용 범위·한계 카드 |
| 52–60s | 에디토리얼 | 로컬 빌드 4단계와 저장소 주소. npm 미공개 안내 |

## 사실 검증

- 명령은 모두 현재 README의 로컬 빌드 기준입니다: `node dist/cli.js ...`. `npx kkomkkom` 설치를 암시하지 않습니다.
- `--artifacts`는 개발 서버·빌드·설치 없이 정적 배포물을 검사하고, `--production-url`은 사용자가 준비한 loopback 서버에 GET만 보냅니다.
- 보호는 명시적 opt-in이며 기본은 미리보기입니다. Git-clean + 승인 hash, private backup, 후속 편집 거부, config-only 복원을 표시했습니다.
- 소스맵 보호를 비밀 보호·역분석 방지·배포 안전 보장으로 표현하지 않았습니다. 브라우저 오류 추적 정보가 줄 수 있음을 표시했습니다.
- 실제 자격증명·원문 config·민감 digest는 영상에 넣지 않았습니다.

## README 반영·확인

- 포스터는 저장소 상대 경로 이미지, 영상은 저장소 상대 경로 링크입니다. 비공개 저장소이므로 접근 권한이 없는 사용자에게 공개 데모처럼 안내하지 않습니다.
- 반영 후 GitHub API의 렌더된 README HTML에서 이미지·링크가 실제로 남아 있는지 확인합니다.
  `gh api repos/hodoi-ing/kkomkkom/readme -H "Accept: application/vnd.github.html"`
- 대용량 편집 원본과 `node_modules`는 소스 저장소에 넣지 않았습니다. 렌더된 MP4(2.7MB)와 포스터(159KB)만 README용으로 포함했습니다.

## 완료 확인

- [x] 기존 영상 파일·구성 확인 및 최신 기능 기준으로 수정
- [x] 60초·1920×1080·30fps·무음 유지, 기존 렌더 보존
- [x] `npm run check` 0 error, 대표 프레임 가독성 확인
- [x] 새 MP4·포스터를 별도 이름으로 렌더
- [x] README 상단 포스터·MP4 링크와 `docs/demo.md` 갱신
- [x] GitHub 렌더 HTML에서 이미지·링크 확인 — 2026-10-23 `gh api .../readme -H "Accept: application/vnd.github.html"`로 `<img src="docs/assets/kkomkkom-intro-v2-poster.png">`와 MP4 링크 보존 확인. `raw.githubusercontent.com` 자산은 인증 요청 200(MP4 2,818,300B, PNG 159,023B).
- [x] 대체 링크 방식 적용 — GitHub 저장소 MP4 인라인 재생은 지원되지 않아 포스터+링크 유지. 브라우저에서의 실제 인라인 재생은 확인/주장하지 않음.
