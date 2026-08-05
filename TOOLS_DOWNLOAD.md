# AI 개발 도구 다운로드 가이드 🛠️

이 페이지는 GIIP Agent System을 사용하기 위한 모든 AI 개발 도구의 다운로드 링크와 설치 방법을 제공합니다.

## 📋 목차
- [필수 도구](#-필수-도구)
- [AI 에이전트 도구](#-ai-에이전트-도구)
- [개발 환경 (IDE/Editor)](#-개발-환경-ideeditor)
- [추가 유용한 도구](#-추가-유용한-도구)

---

## 🔧 필수 도구

모든 사용자가 먼저 설치해야 하는 기본 도구들입니다.

### 1. PowerShell 7+
Windows 시스템에서 스크립트 실행에 필요합니다.

- **다운로드**: [Microsoft PowerShell 공식 페이지](https://learn.microsoft.com/ko-kr/powershell/scripting/install/installing-powershell-on-windows)
- **설치 방법**: 
  ```powershell
  # Windows 10/11 winget을 통한 설치 (권장)
  winget install --id Microsoft.PowerShell --source winget
  ```
- **확인**: 
  ```powershell
  pwsh --version
  ```

### 2. Node.js (LTS 버전)
Gemini CLI 및 기타 JavaScript 도구 실행에 필요합니다.

- **다운로드**: [Node.js 공식 사이트](https://nodejs.org/)
- **권장 버전**: LTS (Long Term Support) 버전
- **설치 후 확인**:
  ```bash
  node --version
  npm --version
  ```

### 3. Git
버전 관리 및 저장소 클론에 필요합니다.

- **다운로드**: [Git 공식 사이트](https://git-scm.com/downloads)
- **설치 후 확인**:
  ```bash
  git --version
  ```

---

## 🤖 AI 에이전트 도구

GIIP Agent System과 호환되는 AI 개발 도구들입니다.

### 1. Antigravity ⭐ (권장)
Google Gemini 기반의 강력한 AI 코딩 도구입니다.

- **다운로드**: [Antigravity 공식 사이트](https://antigravity.google)
- **상세 가이드**: [Antigravity 상세 보기](docs/04-tools/antigravity.md) \| [Antigravity 사용 가이드](ANTIGRAVITY_USAGE_GUIDE.md)
- **특징**: 
  - PDCA 방법론 기반 개발
  - Bkit Vibecoding Kit 통합
  - 한국어 우선 지원
- **API Key (선택 사항)**: 백그라운드 자동화 기능 사용 시에만 필요 ([Google AI Studio](https://aistudio.google.com/app/apikey)에서 무료 발급)

### 2. Gemini CLI
명령줄에서 Google Gemini API를 사용할 수 있는 도구입니다.

- **설치**:
  ```bash
  npm install -g @google/gemini-cli
  ```
- **API Key 설정 필수**: 백그라운드 자동 세션 실행을 위해 반드시 필요 ([Google AI Studio](https://aistudio.google.com/app/apikey))
- **상세 가이드**: [Gemini CLI 상세 보기](docs/04-tools/gemini-cli.md)
- **공식 문서**: [Gemini CLI GitHub](https://github.com/google/generative-ai-js)

### 3. Cursor
AI 기능이 통합된 차세대 코드 에디터입니다.

- **다운로드**: [Cursor 공식 사이트](https://www.cursor.com/)
- **상세 가이드**: [Cursor 상세 보기](docs/04-tools/cursor.md)
- **가격**: 무료 버전 / Pro 버전 (월 $20)
- **특징**: 
  - GPT-4 및 Claude 모델 지원
  - `.cursorrules` 자동 인식
  - VS Code 기반 UI

### 4. Windsurf
Codeium의 AI 코딩 도구입니다.

- **다운로드**: [Windsurf 공식 사이트](https://windsurf.ai/)
- **상세 가이드**: [Windsurf 상세 보기](docs/04-tools/windsurf.md)
- **가격**: 무료 / Pro 버전
- **특징**:
  - Flow state 기반 개발
  - 여러 AI 모델 지원
  - VS Code 호환

### 5. GitHub Copilot
Microsoft/OpenAI의 AI 코딩 어시스턴트입니다.

- **설치**: VS Code 확장 프로그램으로 설치
  - [GitHub Copilot 확장](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
- **가격**: 
  - 개인 사용자: 월 $10 또는 연 $100
  - 학생/오픈소스 기여자: 무료
  - 기업: 월 $19/사용자
- **특징**:
  - VS Code, Visual Studio, JetBrains 등 다양한 IDE 지원
  - `COPILOT_INSTRUCTIONS.md` 자동 인식

### 6. Claude (Claude.ai / Claude Code)
Anthropic의 AI 어시스턴트입니다.

- **웹 버전**: [Claude.ai](https://claude.ai/)
- **상세 가이드**: [Claude Code 상세 보기](docs/04-tools/claude-code.md)
- **공식 문서**: [docs.anthropic.com](https://docs.anthropic.com)
  - 현재 비공개 베타
  - [대기자 명단 등록](https://www.anthropic.com/)
- **가격**: 
  - 무료 버전
  - Claude Pro: 월 $20
  - Claude for Work: 월 $30/사용자
- **특징**:
  - 대용량 컨텍스트 지원 (200K 토큰)
  - Superpowers 플러그인 호환

---

## 💻 개발 환경 (IDE/Editor)

### 1. Visual Studio Code (VS Code)
무료 오픈소스 코드 에디터입니다.

- **다운로드**: [VS Code 공식 사이트](https://code.visualstudio.com/)
- **상세 가이드**: [VS Code & Autopilot 상세 보기](docs/04-tools/vscode.md)
- **확장 프로그램**:
  - [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
  - [PowerShell](https://marketplace.visualstudio.com/items?itemName=ms-vscode.PowerShell)
  - [GitLens](https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens)

### 2. Visual Studio
Windows용 종합 IDE입니다.

- **다운로드**: [Visual Studio](https://visualstudio.microsoft.com/ko/)
- **무료 버전**: Community Edition
- **GitHub Copilot 지원**: 확장으로 설치 가능

### 3. JetBrains IDEs
전문 개발자용 IDE 제품군입니다.

- **제품**: IntelliJ IDEA, PyCharm, WebStorm 등
- **다운로드**: [JetBrains 공식 사이트](https://www.jetbrains.com/)
- **GitHub Copilot 지원**: 플러그인으로 설치 가능

---

## 🔨 추가 유용한 도구

### 1. Windows Terminal
현대적인 터미널 애플리케이션입니다.

- **다운로드**: [Microsoft Store](https://apps.microsoft.com/store/detail/windows-terminal/9N0DX20HK701)
- **또는**:
  ```powershell
  winget install --id Microsoft.WindowsTerminal
  ```

### 2. GitHub Desktop
GUI 기반 Git 클라이언트입니다.

- **다운로드**: [GitHub Desktop](https://desktop.github.com/)
- **특징**: Git 명령어를 몰라도 사용 가능

### 3. Postman
API 테스트 도구입니다.

- **다운로드**: [Postman](https://www.postman.com/downloads/)
- **용도**: REST API 테스트 및 문서화

### 4. ocr (OpenCodeReview CLI)
`/code-review` 스킬(Check 단계)이 첫 패스로 사용하는 결정론적 규칙 체크리스트 도구입니다.

- **레포**: [alibaba/open-code-review](https://github.com/alibaba/open-code-review) (Apache-2.0)
- **설치 불필요**: `npx -y -p @alibaba-group/open-code-review ocr delegate rule <file...>`
- **특징**: `delegate` 서브커맨드는 LLM 호출·API 키 없이 규칙 체크리스트만 출력 — 별도 계정/과금 없음
- **용도**: JS/TS·React·보안(XSS/인젝션 등) 규칙을 기계적으로 먼저 훑고, 나머지는 에이전트가 직접 판단

---

## 📚 API Key 발급 가이드

### Google Gemini API
1. [Google AI Studio](https://aistudio.google.com/app/apikey) 방문
2. Google 계정으로 로그인
3. "Get API Key" 클릭
4. 새 프로젝트 생성 또는 기존 프로젝트 선택
5. API Key 복사
6. `.agent/settings.json`에 저장

### OpenAI API (선택사항)
1. [OpenAI Platform](https://platform.openai.com/) 방문
2. 계정 생성 및 로그인
3. API Keys 메뉴 선택
4. "Create new secret key" 클릭
5. API Key 복사 및 안전하게 보관

### Anthropic API (선택사항)
1. [Anthropic Console](https://console.anthropic.com/) 방문
2. 계정 생성 및 로그인
3. API Keys 생성
4. API Key 복사 및 안전하게 보관

---

## 🆘 지원 및 문의

- **GitHub Issues**: [giip-dev-agent Issues](https://github.com/LowyShin/giip-dev-agent/issues)
- **GIIP 공식 홈페이지**: [https://giip.littleworld.net/](https://giip.littleworld.net/)
- **커뮤니티**: [GitHub Discussions](https://github.com/LowyShin/giip-dev-agent/discussions)

---

## ⚠️ 중요 사항

1. **API Key 보안**: API Key는 절대 공개 저장소에 커밋하지 마세요.
2. **무료 할당량**: 각 서비스의 무료 할당량을 확인하세요.
3. **라이선스**: 각 도구의 라이선스 조건을 확인하고 준수하세요.
4. **최신 버전**: 이 문서의 정보는 2026년 2월 기준입니다. 최신 정보는 각 공식 사이트를 확인하세요.

---

**Last Updated**: 2026-02-07  
**Maintained by**: GIIP Agent System Team
