# Paperthin 스킬 이식 출처 (Attribution)

이 디렉토리의 아래 스킬들은 **[LilMGenius/paperthin](https://github.com/LilMGenius/paperthin)** (MIT License, Copyright © 2026 LilMGenius) 에서 이식했습니다. paperthin은 "아티팩트를 깨끗하고 참되게(clean & true)" 유지하는 에이전트-불문 저수준 스킬 모음입니다.

## 1. Verbatim imported (원본 기반 이식)

| 스킬 | 한줄 설명 | 유형 |
|---|---|---|
| `re0` | 표류한 아티팩트를 패치가 아닌 깨끗한 v0로 재작성 | model |
| `shower` | 컨텍스트 없는 서브세션으로 콜드리드 — 홀로 서는가? | model |
| `factchk` | 주장을 양방향으로 소스 대조 검증 (허구는 제외) | model |
| `mandela` | eval·지표의 누수(leakage) 감사 — 외부 ground-truth가 실제로 들어오는가 | model |
| `autobahn` | 위험 인접 범위를 사전 분리, 안전한 나머지를 클린룸에서 전력 실행 | model |
| `sip` | 산출물 직후 레포 자체 clean-and-true 체크로 자가검증 | model |
| `hate` | 계획을 죽일 단 하나의 반론 + 가장 싼 반증 실험 | user |
| `dedash` | em-dash 및 유사문자 제거 (역할별 문장부호 선택) | user |
| `re0-git` | 완료된 커밋 메시지를 `git log`만으로 핸드오프되게 정리 | user |
| `ssotchk` | 하나의 사실이 흩어진 곳을 찾아 정본을 지정 (읽기전용) | model |
| `ssotize` | 흩어진 사실을 하나의 정본으로 통합하고 나머지는 참조로 | model |
| `re0-work` | 검증된 교훈만 보존하며 v0에서 재시작 | model |
| `flywheel` | build→QA→retro→re0-work 루프로 코드가 아닌 학습을 누적 | model |
| `nba` | 현재 사이클 상태를 읽어 단 하나의 다음 최선 행동 반환 (읽기전용) | model |

## 2. Adapted into GIIP (패턴만 이식, 신규 Skill 없음)

| 원본 | 통합 위치 | 내용 |
|---|---|---|
| `readchk`, `aim` | `.agent/rules/32_request_comprehension.md` | 요청 해석 검증 강화 |
| `debloat`, `detool`, `reorder` | `.agent/rules/33_artifact_hygiene.md` | 아티팩트 위생 규칙 강화 |
| `macrothink` | `.agent/roles/analyst.md` + `.agent/roles/orchestrator.md` | 해결책 먼저 제시 시 문제 분리 패턴 |
| `prism` | `.agent/roles/orchestrator.md` + `.agent/roles/design-validator.md` | 다중 Role 결과 종합 패턴 |
| `feynman` | `.agent/roles/design-validator.md` | 설계 검증 질문 패턴 |
| `catchup` | `.agent/roles/orchestrator.md` + `.agent/roles/pdca-iterator.md` | 장기 작업 복구 패턴 |

## 3. Intentionally not imported (의도적 미이식)

| 항목 | 이유 |
|---|---|
| `modelchk` | GIIP Agent의 execution routing 범위와 맞지 않음 |
| `re0-plan` | 기존 PDCA/K-Layer와 중복 |
| `re0-loop` | 기존 PDCA/K-Layer와 중복 |
| `re0-memo` | 기존 K-Layer와 중복 |
| `re0-work` | 기존 work_history/K-Layer와 중복 |
| `re0-git` | 기존 Git/commit 운영 방식과 중복 |
| `re0-release` | 기존 배포 운영 방식과 중복 |
| `re0-merge` | 기존 PR/병합 운영 방식과 중복 |
| `retro` | 이 레포에는 이미 gstack + K-Layer 통합형 `retro`가 존재하여 덮어쓰지 않음 |
| `ppt-upgrade` | paperthin의 `npx skills` 설치 재조정 전용이라 이 환경과 무관하여 제외 |

## MIT 라이선스 고지

```
MIT License — Copyright (c) 2026 LilMGenius
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

paperthin 자체가 [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, © 2026 Matt Pocock)의 아키텍처·철학을 채택하고 있습니다.
