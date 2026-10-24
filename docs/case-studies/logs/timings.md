# 실행 시간과 최대 RSS (익명 공개판, 반올림 요약)

이 표는 **반올림한 요약**이다. 정확한 초 단위 소수와 KB 단위 RSS는 내부 원본에만 있다. 값은 단발 관측이며 성능 보장이 아니다.

| 사례 | 단계 | 시간(반올림) | 최대 RSS(반올림) |
|---|---|---:|---:|
| A | full `--json` | 84 s | 2.36 GB |
| A | fast `--fast --json` | 22 s | 1.69 GB |
| A | artifacts `--strict` | 0.8 s | 124 MB |
| B | full `--json` | 35 s | 1.18 GB |
| B | fast `--fast --json` | 14 s | 1.28 GB |
| B | artifacts `--strict` | 0.8 s | 141 MB |
| C | full `--json` | 25 s | 2.06 GB |
| C | fast `--fast --json` | 10 s | 1.56 GB |
| C | artifacts `--strict` | 1.2 s | 148 MB |
| D | full `--json` | 21 s | 1.02 GB |
| D | fast `--fast --json` | 4.2 s | 957 MB |
| D | artifacts `--strict` | 0.3 s | 122 MB |
| E | full `--json` | 28 s | 945 MB |

## 설치·빌드 시간에 대한 주의

- 설치·빌드 시간은 캐시·Node 버전·패키지 관리자에 따라 달라 표에서 제외했다. 정확한 값은 내부 원본에 있다.
- B는 **최초 실행**과 **후속 재설치**가 별개다. 후속 disposable clone의 `npm ci --ignore-scripts`는 약 10.83초, 빌드는 약 25.93초였고, 최초 5개 실행의 수치와 섞지 않는다.
- 후속 B의 `--json`, 합성 증가, 인증 HTTP는 시간/RSS를 별도로 측정하지 않았다.
