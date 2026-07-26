# What's New 페이지 유지 (Rolling 7-Day) — MANDATORY

> **HARD RULE** — 이 규칙은 기본 동작보다 우선한다.

## 핵심 규칙
사용자에게 의미 있는 변경(기능·문서·스킬·규칙·버그수정 등)을 완료할 때마다,
그 내용을 **[`docs/WHATS_NEW.md`](../../docs/WHATS_NEW.md)** 상단에 항목으로 추가한다.
이 페이지는 **최근 7일 이내** 갱신만 유지하는 롤링 창(rolling window)이다.

- 대상: 저장소에 반영되는 눈에 띄는 변경 1건. 내부 리팩터링·오타 등 사소한 것은 생략 가능.
- 위치: `docs/WHATS_NEW.md` (README 최상단에서 링크됨).
- 전체 이력 아카이브는 [`docs/HISTORY.md`](../../docs/HISTORY.md)가 담당한다(삭제하지 않는다).

## 절차
1. **항목 추가**: `## YYYY-MM-DD` 날짜 섹션(없으면 생성) 아래에 한 줄 요약을 추가한다.
   - 형식: `- **<제목>** — <한줄 설명>. → [관련 파일/문서 링크]`
   - 문서를 수정/생성했으면 [규칙 37](37_repo_url_in_report.md)에 따라 링크를 건다.
   - 최신 날짜 섹션이 맨 위에 오도록 역순 정렬한다.
2. **기준일 갱신**: 파일 상단의 `기준일 (as of): YYYY-MM-DD`를 오늘 날짜로 갱신한다.
3. **7일 초과분 이관(prune)**: 오늘 기준 7일보다 오래된 날짜 섹션은 `WHATS_NEW.md`에서 제거하고,
   해당 내용을 `docs/HISTORY.md`에 시간순으로 옮겨 적는다(정보 손실 없이 이관).
4. **함께 커밋**: What's New 갱신은 원 변경과 **같은 커밋**에 포함한다([규칙 35](35_commit_push_per_task.md)).

## Why
- 사용자가 README 최상단 링크 하나로 "요즘 뭐가 바뀌었나"를 즉시 파악하도록 한다.
- 롤링 7일 창으로 항상 신선하게 유지하고, 오래된 항목은 `HISTORY.md`에 보존해 이력을 잃지 않는다.

## 관련 규칙
- [37_repo_url_in_report.md](37_repo_url_in_report.md) — 문서 링크 URL 규칙
- [35_commit_push_per_task.md](35_commit_push_per_task.md) — 태스크마다 커밋·push
