# 진행 상황을 giip issue 코멘트로 자주 남긴다 (Progress Comment) — 미러

> **정본(SSOT)**: `giipprj/.agent/rules/PROTOCOL_PROGRESS_COMMENT.md`. 이 파일은 giip-fde-agent 연동용 미러다(동기화 대상).
> 2026-07-30: giip-813 인시던트(다중 레포 PR을 몰아서 보고) 조사 중 이 레포엔 미러 자체가 없던 것을 발견해 신설.

## 전제 (Gate)
- **giip issue API 접근 가능 + 작업 중인 이슈 번호(isn)를 알 때만** 적용. **isn 미상/미연동이면 전량 조용히 스킵.**

## 상태 전이는 항상 코멘트를 동반한다 (강화 규정, giip #1146~1151/#1155 인시던트 재발방지)
- 2026-08-16: 자매 프로젝트(giipprj, csn 47)에서 무인 세션이 giip 이슈 여러 건을 IN_PROGRESS 로
  전이시키면서 **코멘트를 전혀 남기지 않아** 누가/언제/왜 착수했는지 추적 불가능했던 인시던트
  (giip #1146~1151/#1155)가 발생했다. 이 레포(`slack-bot/giip-task.js` `maybeFinish`)도
  `handlers.js` 가 `comment=null` 로 IN_PROGRESS 전이를 호출해 동일한 결함을 갖고 있었다.
- **단독 상태변경 금지**(위 §"남기는 시점" 5번 규정의 강화): 상태 전이(PENDING→READY→
  IN_PROGRESS→REVIEW/DONE 등)는 반드시 코멘트를 동반해야 하며, 그 코멘트에는 다음 3요소를
  명시한다.
  - **행위자(Actor)**: 어느 배포/누가 처리했는지. 이 레포는 `GIIP_ACTOR_TAG` 환경변수로
    배포자가 지정한다(예: 이 PC 배포=`lowyclaude`). 미설정 시 `slack-bot@<hostname>` 자동 폴백.
  - **시각(When)**: ISO 타임스탬프.
  - **사유(Why)**: 왜 이 상태로 전이하는지. caller 가 준 comment 가 있으면 그 내용, 없으면
    "(자동 전이, 상세 사유 미기재)".
- **코드 레벨 강제(2026-08-18 갱신, giip #1211)**: 2026-08-16 판(위 문단)은 `giip-task.js#maybeFinish`
  에만 강제를 걸어, 이를 거치지 않는 `giip-commands.js`(`giip issue done/review/progress` Slack
  명령)와 `handlers.js` 의 일부 `issueUpdate` 직접 호출은 여전히 코멘트 없이 조용히 상태만
  바뀌는 구멍이 남아 있었다(giipprj `updateIssueStatus.ps1` 이 `-Actor`/`-Reason` opt-in 이라
  실효성이 없었던 것과 동일한 근본 결함). 이제 이 함수는 **`slack-bot/giip-api.js#issueUpdate`
  자체**로 이동했다 — `fields.status` 가 주어지고 실제로 값이 바뀌면(현재 상태를 읽어 대조),
  호출부가 무엇이든(`giip-commands.js` 직접 호출 포함) 항상 "[Actor] ISN X 상태전이:
  `<이전상태>` -> `<새상태>`" 헤더가 붙은 코멘트를 자동 등록한다(이전상태도 이번에 추가 — 과거엔
  `→ <새상태>`만 표기해 "어느 상태에서" 왔는지가 없었다). `actor`/`reason` 은 `opts` 로 넘길 수
  있고(기본값: `actorTag()`/`"(사유 미기재 - 자동 기본값)"`), `giip-task.js#maybeFinish` 는
  자신이 별도로 코멘트를 만들지 않고 이 `opts.reason` 에 caller comment 를 실어 넘기기만 한다
  (중복 코멘트 방지). `skipComment` opts 는 향후 호출부가 자체 코멘트를 남기고 싶을 때만 쓴다.
  `slack-bot-minimax/`도 동일하게 적용(byte-identical 유지). `slack-bot-openclaw/`는 giip 이슈
  연동 코드 자체가 없어 해당 없음.
- 정본 쪽은 `giipprj/giipdb/mgmt/updateIssueStatus.ps1`(giip #1211, `-Actor`/`-Reason` 이 비어도
  기본값으로 채워 항상 코멘트) — 접근 방식은 다르지만(PowerShell vs Node HTTP API) "opt-in 이면
  실효성이 없다"는 동일한 교훈을 반영한다.

## 남기는 시점 (논리 단위로, 각 1~3줄 note)
파일 1개당 코멘트 1개 강제 금지. **논리 묶음** 단위로:
1. **착수**: 로드해 따르는 role/rule/skill/workflow 명시.
2. **참조 정본 변경**: 따라야 할 role/rule/skill/workflow 파일 자체를 수정할 때 — 무엇을 왜.
3. **대상 파일 변경**: 수정/생성/삭제한 소스·문서를 논리 묶음마다 — 경로 + 한 줄.
   **다중 레포 작업이면 레포 하나 PR 낼 때마다 그 자리에서 즉시 코멘트** — 여러 레포를 다 처리한 뒤
   몰아서 보고하지 않는다(giip-813 인시던트, 2026-07-30).
4. **검색 발생**: 부득이 grep/find 시 (a)왜 (b)어디에 링크 흡수했는지 보고(Search→Link→Report 연계).
5. **분기·상태전이·막힘·판단**: PENDING→READY→IN_PROGRESS→REVIEW/DONE, 에러·사람 확인 필요, 중요 판단.

**빈도**: 몇 분 이상 작업이면 최소 시작·중간·끝이 코멘트만으로 재구성되게. 스팸 금지.

## 코멘트 방법
이 레포는 giipprj 소속이 아니라 자체 csn(70424)을 쓰므로, giipprj의 `giipdb/mgmt/addIssueComment.ps1`
(DB 직접 append)이 아니라 **이 레포 자체 `slack-bot/giip-api.js`의 SK 기반 HTTP 코멘트 함수**를 쓴다
(lowyworkenv `scripts/gissue/get-issue.sh`와 동일 계열 — `giip-accounts.js`에서 csn에 맞는 SK를 읽어
`giipIssueComments` 엔드포인트로 POST). 한글 콘텐츠는 `\uXXXX` JSON escape로 보내야 안 깨진다
([[reference_giip_issue_sk_api]] 참고).
- 상태 변경(PUT) 자체가 `issueUpdate` 내부에서 상태전이 코멘트를 자동으로 동반한다(위 §"상태 전이는
  항상 코멘트를 동반한다" 2026-08-18 갱신 참고) — 별도로 코멘트 POST 를 먼저/나중에 호출할 필요 없음.

## 연계
- 정본: `giipprj/.agent/rules/PROTOCOL_PROGRESS_COMMENT.md` (전체 규칙·result 게이트·완료 위조 금지 포함).
- nested repo PR 의무: `giipprj/.agent/rules/44_nested_repo_per_repo_pr.md`.
