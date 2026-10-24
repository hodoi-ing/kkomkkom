# Project B

> **공개 정책:** 이 문서는 도구 측정값과 비식별 분류만 기록한다. 개별 보안 판정과 근거는 내부 원본에만 보존하며, 공개판은 취약점 확정이나 대상 식별 자료가 아니다.

익명 사례 B의 측정 결과와 후속 검증 요약이다. 설치·빌드 스크립트 사전 검토 기록은 보존되어 있지 않으며 충분성은 검증되지 않았다.

## 최초 측정

| 실행 | 종료 코드 | coverage | 페이지 | 라우트 | 발견 |
|---|---:|---|---:|---:|---|
| 전체 `--json` | 0 | incomplete | 4 | 18 | warning 7 |
| `--fast --json` | 0 | incomplete | — | 18 | warning 7 |
| `--artifacts --strict` | 1 | incomplete | — | — | 0 |

- 프로덕션 빌드는 성공했다.
- `buildFailed:false`, 페이지 4개 측정.
- 정적 산출물 검사는 설정 wrapper 미지원으로 `unsupported`였다.
- 개별 경고의 보안 판정과 근거는 내부 원본에만 있다.

## 후속 검증 요약

최초 5개 결과와 섞지 않고 별도로 기록한다.

| 항목 | 결과 |
|---|---|
| 범위 축소 기준선 | 4개 패턴 제외, checked 20 / ignored 8 / static-only 7, `coverage: complete` |
| 무변경 비교 | `firstRun:false`, 4페이지 comparable, `deltaBytes:0` |
| 합성 클라이언트 증가 | 500,000자, `deltaBytes` 500,119, `deltaPercent` 55.36%, `heavy:true` |
| 인증 HTTP | 17검사 중 16통과, 1추가검토(근거 내부) |

- `coverage: complete`는 축소된 검사 범위가 실행됐다는 뜻이며, 제외 경로나 기존 finding이 해결됐다는 보안 통과가 아니다.
- 합성 증가는 탐지 실험이며 실제 취약점·전송량·성능 회귀가 아니다.
- 1추가검토 항목은 보안 명세 검증 전이므로 취약점 확정으로 승격하지 않는다.
