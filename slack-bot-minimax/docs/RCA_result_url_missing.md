# RCA: 완료보고 GitHub URL이 사라진 문제

- 발생 인지: 2026-07-03
- 영향: `giipclaude` Slack 봇의 작업 완료보고에서 **어제까지 붙던 GitHub 결과 URL이 오늘부터 누락**
- 상태: 수정·검증 완료 (Lowyworkenv `5d2656d5`, giip-dev-agent `f047b43`), task(20260703143321)

## 증상
완료보고가 어제(예: task `20260702145007`)는 정상이었다:
```
✅ 작업 완료: 20260702145007
📋 태스크 결과 보고서: https://github.com/LowyShin/Lowyworkenv/blob/master/.agent/tasks/done/20260702145007.md
```
오늘부터는 URL 없이 파일 경로만 나오는 폴백 메시지로 바뀌었다.

## 근본 원인 (메모리 문제 아님 — 코드 버그)
완료보고의 URL은 `task-manager.js`의 `gitPushResult()`가 **git push 성공 시에만** 반환한다.
호출부 `index.js`는 `if (githubUrl)` 이 거짓이면 URL 없는 폴백 메시지를 보낸다.

`gitPushResult()`가 null을 반환한 연쇄:
1. slack-bot 런타임 상태 파일(`.bot-threads.json`, `.task-state.json`, `tasklist.json`)이 **git 추적 대상**이었다(Lowyworkenv). 봇이 돌 때마다 수정 → **작업트리 상시 dirty**.
2. `gitPushResult`가 `git pull --rebase origin <branch>` 실행 — 그러나 **dirty 트리에선 rebase가 "cannot pull with rebase: You have unstaged changes"로 거부**된다. 게다가 코드는 **pull 결과를 확인하지 않았다.**
3. 그 상태에서 origin이 로컬보다 앞서 있으면 이어지는 `git push`가 **non-fast-forward로 거부** → status≠0 → **null 반환**.
4. → 완료보고가 URL 없는 폴백으로.

### 왜 어제는 되고 오늘은 안 됐나
- 어제: origin이 봇보다 앞서지 않아 **fast-forward push 성공** → URL 정상.
- 오늘: origin이 앞서감(예: 다른 세션/사람이 같은 브랜치에 push) → 봇 로컬이 뒤처짐 → dirty라 rebase 불가 → push 거부 → URL 증발. **한 번 뒤처지면 스스로 못 따라잡아 계속 실패**한다.

## 수정
1. **`gitPushResult` 견고화** (양쪽 repo): `git pull --rebase --autostash` 로 dirty여도 rebase 가능하게 하고, push 거부 시 `fetch` 후 rebase+push **1회 재시도**. rebase 실패 시 `rebase --abort`로 중간상태 방지.
2. **런타임 상태 untrack** (Lowyworkenv): `.gitignore`에 3파일 추가 + `git rm --cached`. (giip는 이미 미추적 — `.gitignore` 패턴만 보강.)
3. **폴백 메시지 개선** (양쪽): push 실패 시 "원격 미반영이라 URL 미생성" 사유 명시로 조용한 손실 방지.

## 검증
- dirty 트리(7파일)에서 `git pull --rebase --autostash origin master` → **exit 0**(구버그의 거부 지점 통과), 편집 보존.
- 수정 파일 `node --check` 전부 통과.
- 봇 pm2 재시작(PID 34796) 후 Socket Mode 정상 접속.

## 재발 방지
- 규칙: `Lowyworkenv/.agent/rules/38_slackbot_push_reliability.md`.
- 핵심: **런타임 상태는 절대 git 추적하지 않는다** + **push는 autostash·재시도로 견고하게**. 완료보고 URL은 push 성공에 의존하므로 push 신뢰성이 곧 보고 신뢰성이다.
