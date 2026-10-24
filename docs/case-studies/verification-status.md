# 검수 상태 — 2026-10-23

> **공개 정책:** 이 문서는 도구 측정값과 비식별 분류만 기록한다. 개별 보안 판정과 근거는 내부 원본에만 보존하며, 공개판은 취약점 확정이나 대상 식별 자료가 아니다.

이 문서는 익명 사례 연구의 **검사 시점과 원격 대조 상태**만 기록한다. 새로운 기능 검증이나 현재 원격 코드의 전체 재검증 결과가 아니다.

## 검사 시점

- 검사 도구 `kkomkkom` 0.1.0, commit `ff6cc750c42b1171a700ae28b3c0dd00d5d7e2d7`.
- 이 SHA는 내부 `logs/results.json`의 `tool.commit`에서 읽었다.
- 검사일: 2026-10-23. 플랫폼: Linux(WSL2), Node 20·22·26.
- 대상 식별 정보·저장소 SHA·고유 경로는 내부에만 있다.

## 원격 대조 (read-only, 2026-10-23)

| 항목 | 값 |
|---|---|
| origin | `hodoi-ing/kkomkkom` 확인 |
| local HEAD | `ff6cc750c42b1171a700ae28b3c0dd00d5d7e2d7` |
| remote main | `56bc7f8f59ebda6cf5d1a789b646369c6f7d0e44` |
| merge-base | `56bc7f8f59ebda6cf5d1a789b646369c6f7d0e44` |
| ahead / behind | 1 / 0 |
| 충돌 | 없음. remote main이 조상이고, remote 쪽 변경 파일이 없다. |

- local HEAD는 remote main보다 1커밋 앞서며, 그 차이는 `docs/` 측정·검증 기록, `docs/demo.md`, `TASKLIST.md`, `.gitignore`에 한정된다.
- `src/`, `scripts/`, `fixtures/`, `package.json`, 설정, 워크플로우에는 local/remote 차이가 없다.
- **현재 remote main의 코드를 새로 전체 검증한 것이 아니다.** 위 검사 시점(로컬 HEAD)의 기록 범위로만 읽어야 한다.
- worktree·branch를 원격에 맞춰 덮어쓰지 않았다.

## 문구 검증 상태

- 발행용 문구의 patina 검증은 인증 준비 부족으로 **미완료**다. 이 문서와 사례 연구는 검수용 초안이며, 검증된 rewrite로 표기하지 않는다.
- 실패한 파일을 수동 rewrite로 대체하지 않았다.

## 변경·검증 경계

- 꼼꼼 제품 코드·설정·의존성과 원격 upstream은 수정하지 않았다.
- 최초 5개 복제 소스는 수정하지 않았다.
- 후속 disposable clone에서만 검사 범위 설정과 합성 payload를 추가했다가 삭제했다. 최신 코드 동결 지시 전에 수행한 별도 실험이다.
- 이 문서 작성 과정에서 제품 테스트·설치·빌드를 다시 실행하지 않았다.
