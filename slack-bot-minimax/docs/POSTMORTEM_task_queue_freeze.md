# Postmortem — Task 큐 "멈춤"(READY 정체 / IN_PROGRESS 미표시)

- 발생 인지: 2026-07-24
- 대상: `Lowyworkenv/slack-bot` (라이브 운용본, pm2 `slack-bot`)
- 증상 보고(요지): "🚀 明示的な依頼のため自動実行します（`go` 不要）。中断: `cancel giip-738`" 이 뜨는데
  진행되는 게 없이 `READY` 로 멈춰 보인다. **언제부터 "처리 중(IN_PROGRESS)"이 안 보이나?**

---

## 1. 조사 시점의 라이브 실측

`.task-state.json` (조사 시점):

- `running`: **giip-738** `@2026-07-24T11:37:21.101Z` — 요청(11:37:15) 6초 뒤 실행 시작. 현재(11:41) `claude.exe` 서브에이전트 다수 생존 → **실제로 실행 중이었음**(멈춘 게 아님).
- `pending`: **12건** (giip-611·634·643·645·649·652·657·661·674·728·730 + 구 `20260708…`).
  전부 `queuedBehind`/`queuedAt` 마커 **없음**(0건).

즉 giip-738 자체는 정상 실행 중이었고, "멈춤"으로 보인 실체는 **pending 에 쌓인 orphan 12건 + 표시상 오해** 였다.

## 2. 근본 원인

### (A) "언제부터 IN_PROGRESS 가 안 보이나" — 의도된 설계 변경(2026-07-14)

- `77430958` (07-14) — *명시적 명령형은 분석 후 자동 실행 + giip `IN_PROGRESS` 전이를 실행 시점으로 이관*
- `8d6b0a0a` (07-14) — *신규 issue 는 `PENDING` 로 생성*

이전엔 **요청/분석 즉시** 이슈를 `IN_PROGRESS` 로 찍어서 "아무것도 안 도는데 IN_PROGRESS·`go` 요구" 모순이 있었다.
이를 고쳐 `IN_PROGRESS` 전이를 **실제 서브에이전트 실행 시작**(`handlers.js` `startTaskExecution`) 시점으로 미뤘다.
결과적으로 분석중·큐 대기·실행 미개시 구간은 전부 `PENDING/READY` 로 보이고,
`IN_PROGRESS` 는 서브에이전트가 실제로 도는 짧은 구간에만 보인다. **회귀가 아니라 설계상 결과.**

부수적으로 봇이 붙여준 "복원 이력"의 `#738 [READY]` 는 **분석 시점 스냅샷**(IN_PROGRESS 전이 6초 전)이지 라이브 상태가 아니다.
또한 로컬 `.agent/tasks/<id>.md` frontmatter 의 `status:` 는 생성 시 1회만 기록되고 running 으로 갱신되지 않아, 파일만 보면 항상 pending 처럼 보인다.

### (B) 진짜 "멈춤" 위험 ① — ghost-occupier freeze (핵심 결함)

직렬 실행이라, 다른 태스크가 작업트리를 점유 중일 때 들어온 태스크는 `pending` 에
`queuedBehind` 마커와 함께 적재되고, **점유 태스크의 `onComplete`/`onError` 가 `drainNextQueued` 를 호출**해야 자동 기동된다.
그런데 **점유 태스크 실행 도중 봇이 재시작**되면 그 서브프로세스가 죽어 `onComplete` 가 영영 발화하지 않는다.
→ `queuedBehind` 대기 태스크는 누구도 기동하지 않아 **영구 동결**. 기동 시 `reconcileTaskState()` 는 `running` 만 청소할 뿐 이 복구를 하지 않았다.

### (C) 진짜 "멈춤" 위험 ② — orphan pending 무한 누적

`reconcileTaskState()` 는 `running` 만 reconcile 하고 **`pending` 은 전혀 손대지 않았다.**
세션·수동·타 클론 등 다른 경로로 이미 처리된 태스크의 pending 항목이 정리되지 않고 무한 누적 → 조사 시점 12건.
이것이 대시보드/체감상 "READY 로 방치된 것들"의 실체다.

## 3. 조치 (이 PR)

`index.js` `reconcileTaskState()` + 신규 `recoverQueuedOnStartup()`, `handlers.js` export:

1. **pending 스윕** — `reconcileTaskState()` 가 `done/`·`cancel/` 로 이미 해소된 pending 항목을 제거.
   진짜 미착수 backlog(파일이 `tasks/` 직하)는 건드리지 않는다(마커 없는 pending = 수동 `go` 대기 설계 존중).
2. **ghost-occupier 해동** — `recoverQueuedOnStartup()` 를 **기동 직후 + 주기 reconcile(10분)** 에 호출.
   `running` 이 비었는데 `queuedBehind` 대기 태스크가 있으면 = 동결 상태이므로 `drainNextQueued()` 를 한 번 叩いて 직렬 큐를 되살린다.
   실행 중인 태스크가 있으면 통상 경로에 맡긴다(직렬 보장 유지).

두 조치 모두 **재실행 위험을 회피**한다: 스윕은 이미 해소된 것만 제거하고, 해동은 원래 자동 실행 대상(`queuedBehind`)만 다룬다.
마커 없는 orphan backlog 를 임의로 자동 실행하지는 않는다.

### 검증(반영 절차)

라이브 반영은 **워킹카피 sync + `pm2 restart slack-bot`** 필요(자동 아님). 재시작 시:
- 조사 시점 pending 12건 중 `done/`·`cancel/` 로 해소된 것은 자동 제거된다.
- (해당 시) 동결 큐가 자동 해동된다.
- 로그: `[Bot] reconcile: stale pending … 제거`, `[Bot] startup-recovery: 凍結された待機タスク …`.

## 4. giip-fde-agent(템플릿) 점검 결과

`giip-fde-agent/slack-bot`(사용자 직접 관리 템플릿)은 **더 이전 버전**:
- `reconcileTaskState()` 가 인자 없이 `running` 만 청소 — **staleMinutes 개념/주기 reconcile 없음**, **pending 스윕 없음**.
- `drainNextQueued`/`queuedBehind` **큐·직렬 드레인 메커니즘 자체가 부재** → ghost-occupier freeze 형태는 없으나,
  애초에 직렬 대기열 자동 기동이 없고 stale-running 정리도 라이브본보다 약하다.

→ 동일 부류의 취약(재시작 시 pending 미정리)은 존재. 라이브본과 동등화하려면 위 조치 + 큐 메커니즘 포팅이 필요.
(메모리 규칙상 템플릿은 명시 요청 시에만 포팅하므로, 이 PR 에는 포함하지 않고 별도 승인 대기.)
