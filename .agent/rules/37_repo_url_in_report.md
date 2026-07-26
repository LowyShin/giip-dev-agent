# 완료 보고에 저장소 파일 URL 필수 (MANDATORY)

> **HARD RULE** — 이 규칙은 기본 동작보다 우선한다.

## 핵심 규칙
저장소 내 파일(특히 `.md` 문서)을 **수정하거나 새로 생성**한 뒤 완료 보고를 보낼 때는,
해당 파일의 **원격(remote) 웹 URL을 반드시 포함**한다. 로컬 경로만 적고 URL을 생략하지 않는다.

## URL 도출 (레포 비특화)
하드코딩하지 말고 현재 저장소 정보에서 도출한다.
```
<web-base>/blob/<branch>/<repo-relative-path>
```
- `<web-base>`: `git remote get-url origin`을 웹 형태로 변환한 값
  - 예) `git@github.com:OWNER/REPO.git` → `https://github.com/OWNER/REPO`
  - 예) `https://github.com/OWNER/REPO.git` → `https://github.com/OWNER/REPO`
  - GitHub 외 호스트(GitLab 등)는 각 호스트의 blob/tree 경로 규약을 따른다.
- `<branch>`: 현재 push 대상 브랜치 (`git rev-parse --abbrev-ref HEAD`)
- `<repo-relative-path>`: 저장소 루트 기준 상대 경로, 구분자는 **슬래시(`/`)** (백슬래시 금지)

## 적용 시점
- 여러 파일을 수정했으면 **각 파일마다** URL을 나열한다.
- **push 이후**에 보고하는 것을 원칙으로 한다(원격 반영 후에야 URL이 유효). 커밋·push는 [35_commit_push_per_task.md](35_commit_push_per_task.md)를 따른다.
- 아직 push 전이라 URL이 404일 수 있으면 그 사실을 함께 명시한다.

## 금지 사항
- ❌ 저장소 파일을 수정하고도 완료 보고에 원격 URL 누락
- ❌ 로컬 경로만 적고 원격 URL 생략
- ❌ 백슬래시가 섞인 깨진 URL

**Why:** 리뷰어·사용자가 변경 결과를 클릭 한 번으로 확인할 수 있어야 한다. 경로만 있으면 매번 원격에서 다시 찾아야 하므로 URL을 표준으로 강제한다.
