# Available Skills & Commands

This document summarizes the available skills and commands in the GIIP Agent system.

## 🛠️ Skills & Commands

### PDCA Skill (Unified)
| Command | Description |
|---------|-------------|
| `/pdca status` | Check current PDCA status |
| `/pdca plan {feature}` | Generate Plan document |
| `/pdca design {feature}` | Generate Design document |
| `/pdca do {feature}` | Implementation guide |
| `/pdca analyze {feature}` | Run Gap analysis |
| `/pdca iterate {feature}` | Auto-fix iteration loop |
| `/pdca report {feature}` | Generate completion report |
| `/pdca next` | Guide to next PDCA step |

### Level Skills
| Command | Description |
|---------|-------------|
| `/starter` | Initialize/guide Starter project |
| `/dynamic` | Initialize/guide Dynamic project |
| `/enterprise` | Initialize/guide Enterprise project |

### Pipeline Skills
| Command | Description |
|---------|-------------|
| `/development-pipeline start` | Start development pipeline guide |
| `/development-pipeline status` | Check pipeline progress |
| `/development-pipeline next` | Guide to next pipeline phase |
| `/code-review` | Code review and quality analysis |

### 🛡️ Gstack Skills (v1.5.0)
| Skill | Description |
|-------|-------------|
| `/office-hours` | Product reframing and design doc generation |
| `/ceo-review` | Founder mode thinking and taste review |
| `/careful` | Safety guardrails for destructive commands |
| `/freeze` | Edit lock for specific directories |
| `/guard` | Combo of /careful and /freeze |
| `/cso` | Chief Security Officer audit (OWASP/STRIDE) |

### 🔍 Jikji 파일 탐색 (File Discovery)
| Skill | Description |
|-------|-------------|
| `/jikji` | 토큰 소비 없이 로컬 파일/폴더/문서를 효율적으로 탐색 (Raw 대비 최대 86x 절약) |

**Jikji 명령어**:
- `/jikji {root} "{query}"` – 자연어로 로컬 파일 탐색 (첫 번째 파일 검색 수단)
- `jikji prepare {root} --json` – 루트 인덱스 최초 구축
- `jikji refresh {root} --json` – 변경 사항 갱신
- `jikji doctor {root} --json` – 인덱스 상태 진단

> **규칙**: 파일 탐색 시 `grep`, `ls`, `find`, `rg`, `tree` 보다 **Jikji를 먼저** 사용합니다.

### Skill Authoring & Optimization (스킬 저작·최적화)
| Skill | Description |
|-------|-------------|
| `skill-creator` | 새 스킬을 설계·작성하고 eval로 성능을 측정하며 기존 스킬을 반복 개선. SKILL.md 작성 규범(description=트리거, 프로그레시브 디스클로저, 본문 500줄 이내, `scripts`/`references`/`assets` 번들 구조)의 정본 |
| `skillopt` / `/aioptimize` | 실행 trace(reward<0.8)를 바탕으로 SKILL.md 프롬프트를 바운디드 편집·검증 게이트로 자동 최적화 |
| `skill-stocktake` | 설치된 스킬 인벤토리를 점검하고 중복·노후 스킬을 정리 |

> **원칙(출처: [anthropics/skills skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md))**: 스킬을 새로 만들거나 크게 고칠 때는 `skill-creator`를 먼저 사용한다. 특히 `description`은 "무엇을 하는가"와 "언제 트리거되는가"를 모두 담고, Claude의 **언더트리거 경향을 상쇄하도록 다소 pushy하게** 작성한다. 업스트림 추적은 `.agent/config/update_urls.json`의 `anthropics-skills`.

### K-Layer Knowledge System
| Skill | Description |
|-------|-------------|
| `k-layer` | 작업 이력에서 근거가 연결된 클레임을 추출하고 축적하여 지능적인 답변을 제공 |

**K-Layer 명령어**:
- `/k-layer search {검색어}` – 기존 지식 베이스 검색
- `/k-layer add {topic}` – 새로운 작업 이력의 claim 추가
- `/k-layer summary` – 전체 knowledge base 요약
- `/k-layer invalidate {topic} {CLAIM-NNN}` – 특정 claim 폐기

---

## Paperthin 핵심 기능 연계 (신규 명령 추가 없음)

다음 요구는 기존 명령 체계에 연결해 실행한다.

- 요청 해석 검증 (Request comprehension): `/pdca plan`, `/pdca design`, `/pdca status` 단계에서 `understood as:` 기록 및 모호성 확인
- 반대 관점 검토 (Adversarial review): `/cso`, `/ceo-review`, `/code-review`와 아키텍트·SRE 서브에이전트 조합 사용
- 중단 작업 복귀 (Resume long tasks): `/k-layer search`, Git 변경/커밋, PDCA 문서, Slack 대화를 함께 확인 후 재개 요약 생성

> 금지: Paperthin 전역 설치, 자동 업데이트, `re0-*`, `modelchk` 계열 중복 명령 도입
