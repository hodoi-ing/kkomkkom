# README 대표 이미지

## 제작

- 제작 담당: 현재 사용자 대화 세션 `w1:pA`. 외부 이미지 모델·추가 에이전트·유료 API 없이 직접 SVG를 구성했다.
- 문구: **꼼꼼 / 추측 말고, 근거.** 실제 기능을 설명하는 리포트 그래픽이며 검사 성공이나 배포 안전을 주장하지 않는다.
- 기존 영상의 크림색 종이·명조체, 딥그린·라임 팔레트를 이어받았다. 겹친 리포트, 좌표선·가이드 링, 종이 도트, 엣지 하이라이트로 깊이를 표현했다.
- 미리보기는 Windows ego에서 로컬 폰트를 로드해 확인했다. 외부 폰트 다운로드 없이 기존 영상 프로젝트의 NanumMyeongjo / NanumSquareNeo / D2Coding 파일을 사용했다.

## 산출물

| 파일 | 용도 |
|---|---|
| `docs/assets/kkomkkom-hero.png` | README용 3200×1680 PNG. 517,915B. |
| `docs/assets/kkomkkom-hero.svg` | 글자를 경로로 변환한 벡터. 외부 폰트·외부 이미지 의존 없음. 그림자·질감 일부는 파일 안에 포함한 이미지다. |

README 최상단 중앙 정렬 영역에서 PNG를 사용한다. 이미지에 한국어 alt를 제공하며 기존 제목·배지·영상 블록·보고서 예시는 유지한다. SVG의 title/desc에도 예시 리포트임을 명시했다.

편집 가능한 최초 SVG와 렌더용 HTML, 임시 폰트 사본·미리보기는 이 작업이 소유한 `/tmp/opencode/kkomkkom-hero.B3sikX/`에 있다. 원본 영상 폰트나 기존 README 자산은 덮어쓰지 않았다.

## 확인 기록

- Windows ego 로컬 미리보기: 세 폰트 로드 확인, SVG의 모든 텍스트가 1600×840 캔버스 경계 안에 위치함을 확인했다. 직접 미리보기와 최종 PNG를 열어 타이포·겹침·잘림을 검토했다.
- PDF 인쇄 → pdftocairo 변환으로 고해상도 PNG와 경로화 SVG를 만들었다. SVG에는 text 노드가 없으며 글꼴 설치에 따라 제목이 바뀌지 않는다.
- 신규 자산 검증 PASS: PNG 디코딩·3200×1680 크기, SVG text/script/foreignObject 0개, 외부 참조 0개(모든 href는 내부 참조 또는 포함한 이미지), README 이미지 1개·기존 제목보다 앞에 위치. 375px 축소본에서도 제목과 핵심 문구를 직접 확인했다. `git diff --check` exit 0. 이미지 변경에 무관한 제품 회귀·실제 Next 빌드는 반복하지 않았다.
- 기존 영상 v3의 실제 프레임 9장과 보호 화면 69초를 독립 확인했고, apply 명령에서 필수 보호 옵션이 생략되어 보이는 부분을 영상 담당자에게 수정 요청했다. 이는 영상 검수 지적이며 제품 코드 변경 요청이 아니다.

GitHub 통합·렌더된 README 확인은 결과 수신 후 기록한다. 제품 배포·npm 공개·저장소 공개 전환은 이 작업 범위 밖이다.

## GitHub 통합 결과 (2026-10-23)

- PR #6 merge `254c6ea`, CI `39891611024` **success**(Node 20/22/24 + e2e).
- 렌더된 README HTML에서 hero `src="docs/assets/kkomkkom-hero.png"`가 **1회**, 제목(h1) 앞에 유지됨. alt 텍스트 유지. DEMO_VIDEO v3 포스터/MP4 링크도 그대로 유지됨.
- 인증된 raw 자산 HTTP 200: `kkomkkom-hero.png` 517,915B, `kkomkkom-hero.svg` 419,148B, `kkomkkom-intro-v3.mp4` 4,116,074B, `kkomkkom-intro-v3-poster.png` 159,023B.
- 통합 후 로컬 `main`은 `origin/main`과 동일하며 worktree clean. 공개 전환·npm 공개·제품 배포는 하지 않았다.
