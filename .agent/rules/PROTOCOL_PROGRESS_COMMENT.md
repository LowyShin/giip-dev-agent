# 진행 상황을 giip issue 코멘트로 자주 남긴다 (Progress Comment) — 미러

> **정본(SSOT)**: `giipprj/.agent/rules/PROTOCOL_PROGRESS_COMMENT.md`. 이 파일은 giip-fde-agent 연동용 미러다(동기화 대상).
> 2026-07-30: giip-813 인시던트(다중 레포 PR을 몰아서 보고) 조사 중 이 레포엔 미러 자체가 없던 것을 발견해 신설.

## 전제 (Gate)
- **giip issue API 접근 가능 + 작업 중인 이슈 번호(isn)를 알 때만** 적용. **isn 미상/미연동이면 전량 조용히 스킵.**

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
- 상태 변경은 코멘트와 분리된 별도 status-only PUT으로 처리한다.

## 연계
- 정본: `giipprj/.agent/rules/PROTOCOL_PROGRESS_COMMENT.md` (전체 규칙·result 게이트·완료 위조 금지 포함).
- nested repo PR 의무: `giipprj/.agent/rules/44_nested_repo_per_repo_pr.md`.
