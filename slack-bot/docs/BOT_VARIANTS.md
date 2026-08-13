# slack-bot 변형(variant) 운영 경로 판정 — giip-1068 §9

이 저장소에는 Slack 봇 폴더가 세 개 있다. giip-1063/1068 의 비용 최적화가 **어느 폴더에 적용되는지**와
**왜 나머지는 대상이 아닌지**를 여기에 고정한다. (이슈 §9 "먼저 사용 여부 판정" 결과)

## 1. 판정 결과 요약

| 폴더 | 용도 | 대상 저장소(GITHUB_REPO) | giip-1063/1068 최적화 적용 |
|---|---|---|---|
| `slack-bot/` | 이 저장소(giip-fde-agent)의 실제 이슈 처리 봇 (base) | 사용처별 설정 (`.env.example` 은 플레이스홀더) | **적용** |
| `slack-bot-minimax/` | 별개 다운스트림 프로젝트 **Vegetrade SmartOrder** 전용 독립 배포 | `LowyShin/smartorder-works` (고정값) | 미적용 (대상 아님) |
| `slack-bot-openclaw/` | OpenClaw 게이트웨이 경유 변형 | — | 미적용 (별도 실행 모델) |

## 2. `slack-bot-minimax` — §9.1 체크리스트 실측

이슈 §9.1 이 요구한 다섯 항목을 실제로 확인했다.

| 확인 항목 | 결과 |
|---|---|
| 실행 문서에서 실행을 안내하는가 | `slack-bot-openclaw/README.md` 가 "변형 중 하나"로 언급. 전용 실행 안내 문서는 별도로 있음 |
| `register-startup.ps1` 이 있는가 | **있다** (`slack-bot-minimax/register-startup.ps1`) |
| 독립 실행 진입점이 있는가 | **있다** (`index.js` + 독립 `package.json`, `npm start`) |
| 최근 180일 내 기능 수정 커밋이 있는가 | **있다** (2026-07-30 `a437db9`, `f8c9df7`) |
| `slack-bot` 과 기능이 중복되는가 | 코드 구조는 유사하지만 **대상 프로젝트가 다르다**(아래 §3) |

→ §9.2 기준으로 "사용 가능 경로"다. **근거 없이 미사용으로 처리하지 않는다.**

## 3. 결정: 현행 유지 (통합하지 않고 deprecated 처리도 하지 않는다)

§9.3 은 "공통 모듈을 `slack-bot-core/` 로 분리" 또는 "최소안으로 deprecated 처리"를 권한다.
그러나 이번 조사에서 **두 폴더가 같은 봇의 중복 복사본이 아니라는 결정적 근거**가 나왔다.

```
slack-bot-minimax/.env.example:12
GITHUB_REPO=LowyShin/smartorder-works
```

* `slack-bot-minimax` 는 giip-fde-agent 자신의 이슈 큐를 처리하는 봇이 **아니다**.
  완전히 별개의 다운스트림 프로젝트(Vegetrade SmartOrder, `smartorder-works` 저장소)를 위한
  **독립 배포본**이다. 이 저장소 안에 같이 들어있을 뿐 기능 목적이 다르다.
  (`check_stock_db.js`, `reset_password.js`, `giip-accounts.sample.json` 등 SmartOrder 전용 파일이
  `slack-bot-minimax` 에만 있는 것도 같은 근거다.)
* `slack-bot`(base)이 이 저장소의 실제 이슈 처리 봇이며, giip-1063/1068 이 수정하는 대상이다.
* `minimax-accounts.js`(MiniMax 우선 → Claude 폴백)는 giip-780 대부터 있던 기존 사용자 지시사항이지
  이번에 새로 생긴 구조가 아니다. 즉 `slack-bot` 도 이미 MiniMax 우선 라우팅을 쓴다.

**사용자 결정(2026-08-13): 현행 유지.** 서로 다른 프로젝트를 위한 별개 배포이므로
`slack-bot-core/` 강제 통합이나 `slack-bot-minimax` deprecated 표시는 불필요·부적절하다.

이는 §9.2 가 금지한 "아무 조치 없이 방치"가 아니라, 체크리스트 실측 + 대상 저장소 확인 +
사용자 결정에 근거한 **명시적 판단**이다.

## 4. 따라서 이번 작업(giip-1068)의 적용 범위

`slack-bot/`(base)에만 적용한다.

* 재개 프롬프트 분리 (`prompt-templates.js`, `resume-context-builder.js`)
* 진행 이벤트 (`progress-events.js`, `tools/progress-event.js`)
* 실제 소스 변경 판정 (`retry-checkpoint.changedSourceFiles`)
* 중앙 runtime 경로 (`runtime-paths.js`)
* 배치/Fast Path 수치 정정 (`batch-planner.js`, `cost-tracker.js`)
* read/write 위험도 분리 (`model-router.js`)

`slack-bot-minimax/` 와 `slack-bot-openclaw/` 는 이번 변경에서 **수정하지 않는다**.

## 5. 재검토 조건

다음 중 하나라도 참이 되면 이 판정을 다시 해야 한다.

* `slack-bot-minimax/.env.example` 의 `GITHUB_REPO` 가 이 저장소를 가리키게 바뀐다
* `slack-bot-minimax` 가 giip-fde-agent 의 이슈 큐(`.agent/tasks/`)를 처리하기 시작한다
* 두 봇의 **모델 라우팅 정책이 서로 달라진다**(§9.2 가 금지한 상태)
