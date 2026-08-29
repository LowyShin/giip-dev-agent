# 유용한 에이전트 관련 링크 (Useful Agent Links)

에이전트 시스템 사용 및 개발에 도움이 되는 외부 리소스 모음입니다.

## 🔗 에이전트 리소스 목록

### 📋 [외부 AI 도구 및 레포지토리 목록](./docs/50-technical/ai-repositories-index.md) ([EN](./docs/50-technical/ai-repositories-index_en.md) | [JP](./docs/50-technical/ai-repositories-index_ja.md))
- **설명**: 프로젝트와 연동 가능한 외부 유용한 AI 도구 및 레포지토리를 한눈에 볼 수 있는 통합 리스트입니다.

### [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper) ([상세 소개](./docs/50-technical/clawsweeper-intro.md) | [EN](./docs/50-technical/clawsweeper-intro_en.md) | [JP](./docs/50-technical/clawsweeper-intro_ja.md))
- **설명**: AI를 이용해 대규모 GitHub 레포지토리의 이슈와 PR을 자동으로 분석하고 정리하는 유지관리 봇입니다.

### [kyrolabs/awesome-agents](https://github.com/kyrolabs/awesome-agents)
- **설명**: AI 에이전트 프레임워크, 도구 및 관련 연구 리소스를 엄격하게 선별한 큐레이션 목록(Awesome list)입니다.

### [tom-doerr/repo_posts](https://tom-doerr.github.io/repo_posts/)
- **설명**: Tom Doerr의 다양한 프로젝트와 게시물을 한눈에 볼 수 있도록 구성된 Jekyll 기반의 포트폴리오 사이트입니다.

### [byt3bl33d3r/figaro](https://github.com/byt3bl33d3r/figaro)
- **설명**: Claude Code 및 Claude Computer Use 에이전트를 컨테이너, VM, 물리 기기 등 다양한 환경에서 오케스트레이션하고 관리하는 도구입니다.

### [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- **설명**: 여러 개의 AI 터미널 에이전트(Claude Code, Gemini 등)를 동시에 관리하고, 별도의 워크스페이스에서 병렬 작업을 수행할 수 있게 해주는 터미널 애플리케이션입니다.

### [craigsc/cmux](https://github.com/craigsc/cmux)
- **설명**: 여러 개의 Claude 에이전트를 병렬로 실행하고 효율적으로 관리할 수 있도록 도와주는 도구입니다.

### [gameworkerkim/vibe-investing](https://github.com/gameworkerkim/vibe-investing/blob/main/Awesome%20vibe%20invest.MD)
- **설명**: AI/LLM 기반 투자·트레이딩 레포를 객관 평가(강점/약점/적합 사용자)와 공통 함정 체크리스트 중심으로 정리한 큐레이션입니다.

### [anthropics/skills — skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- **설명**: Anthropic 공식 "스킬을 만드는 스킬". SKILL.md 작성 원칙(설명=트리거·언더트리거 방지의 다소 "pushy"한 description, 프로그레시브 디스클로저, 본문 500줄 이내, `scripts/`·`references/`·`assets/` 번들 리소스 구조)부터 eval 기반 반복 개선과 설명 최적화까지 표준 절차를 제공합니다. **본 레포 `.agent/skills/skill-creator/`에 이식 완료**(업스트림 추적: `.agent/config/update_urls.json`의 `anthropics-skills`).

### [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt)
- **설명**: 에이전트의 가중치를 미세조정하지 않고, 자연어 지침 파일(SKILL.md) 자체를 '학습 가능한 매개변수'로 취급하여 에포크, 배치 크기, 텍스트 편집 예산 및 검증 게이트를 통해 최적화하는 텍스트 공간 에이전트 스킬 최적화 프레임워크입니다.


### [garrytan/gstack](https://github.com/garrytan/gstack) ([분석 리포트](./docs/50-technical/gstack-analysis.md))
- **설명**: Garry Tan의 23가지 전문 에이전트 도구 모음(CEO, Designer, CSO 등)으로 에이전트의 생산성을 극대화합니다.

### [LilMGenius/paperthin](https://github.com/LilMGenius/paperthin)
- **설명**: 아티팩트를 "깨끗하고 참되게(clean & true)" 유지하는 에이전트-불문 저수준 마크다운 스킬 모음(re0/shower/factchk/ssotchk/hate 등). DRY·에고리스 프로그래밍·fail-fast 같은 엔지니어링 지혜를 에이전트가 스스로 꺼내 쓰는 반사동작으로 만듭니다.
- **적용 상태**: 원본 Skill 14종 이식(`.agent/skills/`), 핵심 agentic design pattern은 GIIP Role/Rule 체계에 통합 — 신규 Skill 0개 (출처·매핑: [`.agent/skills/PAPERTHIN_NOTICE.md`](.agent/skills/PAPERTHIN_NOTICE.md))

### [vibeforge1111/keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast)
- **설명**: Codex의 로컬 상태(오래된 채팅·워크트리·로그·비대해진 메타데이터)를 **백업 우선**으로 점검·정리해 성능을 유지하는 스킬. inspect/maintain/repair 3모드, "삭제 대신 아카이브·핸드오프 먼저" 원칙(MIT). **본 레포 `.agent/skills/keep-codex-fast/`에 이식 완료** (`codex-maintenance` 워크플로 포함).

## 🎨 디자인 및 MD 리소스 (Design & MD Resources)

### [designmd.ai](https://designmd.ai)
- **설명**: AI 개발을 위한 고품질 DESIGN.md 파일과 CLI 도구를 제공하는 플랫폼입니다.

### [designmd.app](https://designmd.app)
- **설명**: 400개 이상의 다양한 레퍼런스와 주요 AI 에이전트(Cursor, Claude 등)를 위한 설정 가이드를 제공합니다.

### [getdesign.md](https://getdesign.md)
- **설명**: Stripe, Vercel, Notion 등 유명 브랜드의 디자인 시스템을 역공학한 컬렉션을 제공합니다.

### [designmd.me](https://designmd.me)
- **설명**: URL 입력만으로 모든 웹사이트의 요소를 분석하여 디자인 마크다운 파일로 자동 변환해 줍니다.
