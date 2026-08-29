# 외부 AI 도구 및 레포지토리 목록 (External AI Repositories)

AI 에이전트 시스템과 연동하거나 활용할 수 있는 외부 유용한 레포지토리 및 도구 모음입니다.

## 🤖 AI 에이전트 및 유지관리 도구

### [ClawSweeper](https://github.com/openclaw/clawsweeper) ([소개 페이지](../../docs/50-technical/clawsweeper-intro.md))
- **한줄 소개**: AI를 이용해 대규모 GitHub 레포지토리의 이슈와 PR을 자동으로 분석하고 정리하는 유지관리 봇입니다.

### [awesome-agents](https://github.com/kyrolabs/awesome-agents)
- **한줄 소개**: AI 에이전트 프레임워크, 도구 및 관련 연구 리소스를 선별한 큐레이션 목록입니다.

### [figaro](https://github.com/byt3bl33d3r/figaro)
- **한줄 소개**: Claude Code 등 에이전트를 컨테이너, VM, 물리 기기 등 다양한 환경에서 오케스트레이션하고 관리하는 도구입니다.

### [claude-squad](https://github.com/smtg-ai/claude-squad)
- **한줄 소개**: 여러 AI 터미널 에이전트(Claude Code, Gemini 등)를 동시에 관리하고 별도의 워크스페이스에서 병렬 작업을 수행하는 애플리케이션입니다.

### [cmux](https://github.com/craigsc/cmux)
- **한줄 소개**: 여러 개의 Claude 에이전트를 효율적으로 병렬 실행 및 관리할 수 있도록 도와주는 도구입니다.

### [gstack](https://github.com/garrytan/gstack) ([분석 리포트](../../docs/50-technical/gstack-analysis.md))
- **한줄 소개**: Garry Tan의 23가지 전문 에이전트 도구 모음으로, CEO, 디자이너, 보안 담당자 등 다양한 역할을 수행하게 돕습니다.

### [paperthin](https://github.com/LilMGenius/paperthin)
- **한줄 소개**: 아티팩트를 "깨끗하고 참되게(clean & true)" 유지하는 에이전트-불문 저수준 마크다운 스킬 모음(re0/shower/factchk/ssotchk/hate 등)으로, DRY·에고리스 프로그래밍·fail-fast 같은 엔지니어링 지혜를 에이전트의 자발적 반사동작으로 만듭니다.
- **적용 상태**: 핵심 agentic design pattern을 GIIP Role/Rule 체계에 통합 + 원본 Skill 일부 이식 — 신규 Skill 0개 (출처·매핑: [`.agent/skills/PAPERTHIN_NOTICE.md`](../../.agent/skills/PAPERTHIN_NOTICE.md))

### [keep-codex-fast](https://github.com/vibeforge1111/keep-codex-fast)
- **한줄 소개**: Codex의 로컬 상태(오래된 채팅·워크트리·로그·비대해진 SQLite 메타데이터)를 **백업 우선**으로 점검·정리해 성능을 유지하는 스킬입니다. inspect/maintain/repair 3모드와 "삭제 대신 아카이브, 핸드오프 먼저" 원칙을 따릅니다(MIT).
- **적용 상태**: 본 레포 `.agent/skills/keep-codex-fast/`에 이식 완료 (`codex-maintenance` 워크플로 포함, 월 1회 원본 변경 확인 권장)

### [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) ([분석 리포트](../../docs/70-LowyOpinion/capacydiagram.md))
- **한줄 소개**: Andrej Karpathy가 제안한 AI 에이전트 기반의 지속적인 지식 축적 및 위키 관리 패턴(K-Layer의 원형)입니다.

### [skill-creator (anthropics/skills)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- **한줄 소개**: Anthropic 공식 "스킬을 만드는 스킬". description=트리거(언더트리거 방지용 pushy 작성), 프로그레시브 디스클로저, 본문 500줄 이내, `scripts`/`references`/`assets` 번들 구조 등 SKILL.md 작성 규범과 eval 기반 반복·설명 최적화 절차를 정의합니다.
- **적용 상태**: 본 레포 `.agent/skills/skill-creator/`에 이식 완료 (업스트림 추적: [`.agent/config/update_urls.json`](../../.agent/config/update_urls.json)의 `anthropics-skills`)

### [SkillOpt](https://github.com/microsoft/SkillOpt)
- **한줄 소개**: 가중치 학습 없이 에이전트의 스킬 지침 파일(SKILL.md)을 미니배치, 학습률(텍스트 편집 예산), 검증 게이트를 통해 최적화하는 텍스트 기반 강화학습 프레임워크입니다.

### [tom-doerr/repo_posts](https://tom-doerr.github.io/repo_posts/)
- **한줄 소개**: Tom Doerr의 다양한 프로젝트와 게시물을 한눈에 볼 수 있도록 구성된 Jekyll 기반의 포트폴리오 사이트입니다.

### [vibe-investing](https://github.com/gameworkerkim/vibe-investing/blob/main/Awesome%20vibe%20invest.MD)
- **한줄 소개**: AI/LLM 기반 투자·트레이딩 레포를 객관 평가(강점/약점/적합 사용자)와 공통 함정 체크리스트 중심으로 정리한 큐레이션입니다.

### [moa](https://github.com/stanlee7/moa) ([분석 리포트](../../docs/90-reports/moa-analysis.report.md))
- **한줄 소개**: 오픈모델 오케스트레이션 게이트웨이 — 미국 오픈모델 위주로 단일 API 뒤에서 AI 팀이 협업하는 한국어 특화 오픈소스 구현(Fugu 아이디어 기반)입니다.

### [jikji](https://github.com/NomaDamas/jikji) ([도구 소개](../../docs/04-tools/jikji.md))
- **한줄 소개**: AI 에이전트가 로컬 파일을 탐색할 때 토큰 소비를 최대 86배 절약하는 비파괴적 파일 탐색 레이어로, `grep`/`find` 대신 먼저 사용합니다.

## 🎨 디자인 및 문서화 도구

### [Open Design](https://github.com/nexu-io/open-design) ([소개 페이지](../../docs/50-technical/open-design-intro.md))
- **한줄 소개**: Claude Design의 오픈소스 대안으로, Claude Code·Codex·Cursor·Copilot 등 주요 AI 에이전트와 MCP로 연동되며 150개의 브랜드 DESIGN.md 시스템과 261개의 컴포넌트를 제공합니다.

### [designmd.ai](https://designmd.ai)
- **한줄 소개**: AI 개발을 위한 고품질 DESIGN.md 파일과 CLI 도구를 제공하는 플랫폼입니다.

### [designmd.app](https://designmd.app)
- **한줄 소개**: 400개 이상의 다양한 레퍼런스와 주요 AI 에이전트(Cursor, Claude 등)를 위한 설정 가이드를 제공합니다.

### [getdesign.md](https://getdesign.md)
- **한줄 소개**: Stripe, Vercel, Notion 등 유명 브랜드의 디자인 시스템을 역공학한 컬렉션을 제공합니다.

### [designmd.me](https://designmd.me)
- **한줄 소개**: URL 입력만으로 모든 웹사이트의 요소를 분석하여 디자인 마크다운 파일로 자동 변환해 줍니다.

## 🔬 과학·연구 전용 스킬 (선택적 다운로드)

> ⚠️ **이 섹션의 스킬은 과학·연구 관련 프로젝트에서만 선택적으로 다운로드하세요.**
> 일반 개발 프로젝트에는 포함하지 않습니다.

### [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)
- **한줄 소개**: 암 유전체학, 신약-표적 결합, 분자동역학, RNA velocity, 지리공간 과학, 시계열 예측, 78개 이상의 과학 데이터베이스 등을 포함하는 147개 이상의 과학·연구 전용 에이전트 스킬 모음입니다.
- **적용 대상**: 생물학, 화학, 의학, 지구과학 등 과학·연구 관련 프로젝트
- **호환 도구**: Cursor, Claude Code, Codex, Google Antigravity 등 Agent Skills 표준을 지원하는 모든 AI 에이전트
- **다운로드 방법**: 해당 프로젝트 루트에서 `git clone https://github.com/K-Dense-AI/scientific-agent-skills` 후 필요한 스킬 파일만 `.agent/skills/`에 복사

---
*작업 이력: 20260429 01:23:55: 외부 AI 레포지토리 리스팅 페이지 생성*
*작업 이력: 20260618: scientific-agent-skills 과학·연구 전용 섹션에 추가 (이슈 #17)*
*작업 이력: 20260618: open-design 디자인 도구 섹션에 추가 (이슈 #19)*
*작업 이력: 20260624: tom-doerr/repo_posts, vibe-investing, moa, designmd.app/getdesign.md/designmd.me 추가 (이슈 #25)*
*작업 이력: 20260624: jikji 추가 (PR #24), moa 분석 리포트 링크 보완 (PR #26)*
*작업 이력: 20260706: paperthin 추가 및 스킬 14종 `.agent/skills/` 이식*
*작업 이력: 20260706: keep-codex-fast 유지관리 도구 섹션에 등록 (스킬은 기존 이식 완료)*
