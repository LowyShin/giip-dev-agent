# DESIGN — slack-bot / 이 PC 작업을 giip issue API 로 통일

> **상태**: 설계 확정용 초안 (2026-07-11). 구현 전 합의 문서.
> **목적**: 이 PC 및 slack-bot 에서 주고받는 **모든 작업**을 로컬 파일이 아니라 **giip issue** 로 관리하고, Slack 에서 **모든 giip API** 를 호출할 수 있게 한다.
> **관계 정리**: **태스크 번호(slack-bot 타임스탬프)** 와 **이슈 번호(giip issue, isn)** 는 지금까지 별개였다 → 본 설계로 **isn 으로 통일**한다. (giip issue 는 giip issue 관리 화면에서 관리.)

---

## 0. 용어
- **AK** (Access Token): 웹 UI 로그인 시 발급되는 **동적 세션 토큰**. `tUserLogin.AccToken`(24h 유효, `ulLogout IS NULL`). 로그인마다 바뀜.
- **SK** (Secret Key): 에이전트용 **정적 키**. `tCorpUser.uSecretKey`. 잘 안 바뀜.
- **isn**: giip issue 번호(PK). giip issue 관리의 기본 식별자.
- **byAK API**: `x-api-key`(=AK 또는 SK) 로 인증하는 giipfaw 함수. 내부적으로 `dbo.lwGetUSNbyat(@token)` 로 usn 도출.

---

## 1. 현행 (As-Is)
- slack-bot(`task-manager.js`)은 요청을 **로컬 파일**로 관리:
  - 태스크 ID = `getTimestampId()` = `YYYYMMDDHHMMSS`
  - 저장: `Lowyworkenv/.agent/tasks/{id}.md`(+`done/`,`cancel/`), 결과 `.agent/results/{id}.md`, 인덱스 `slack-bot/tasklist.json`
  - 생명주기: analyze → createTaskFile → startExecution(claude CLI) → completeTaskFile → gitPushResult(GitHub URL)
- **giip API 미호출, giip 자격증명 없음**(SLACK/GITHUB 토큰만).
- giip issue API 는 **이미 완비**되어 있으나 봇과 연결되어 있지 않음.

## 2. 기존 giip issue API (재사용, 신규개발 불필요)
`giipfaw/giipIssues` — `https://giipfaw.azurewebsites.net/api/giipIssues`
| 메서드 | 동작 | SP | 비고 |
| :-- | :-- | :-- | :-- |
| POST | 생성(isn=0) → **새 isn 반환** | `pApiGiipIssuePutbyAK` | title,content,status,csn,target_lssn,agent_workflow |
| PUT | 수정(isn=N) | `pApiGiipIssuePutbyAK` | ⚠️ **전체 덮어쓰기** (아래 §6) |
| GET | `?isn=` 단건 / `?status=&csn=` 목록 | `pApiGiipIssue{Get,List}byAK` | |
| DELETE | `?isn=` | `pApiGiipIssueDeletebyAK` | |
- 코멘트: `giipfaw/giipIssueComments` (결과 보고를 코멘트로).
- 범용 호출: `giipfaw/giipApi` — `text=<Verb>` → `exec pApi<Verb>byAK` (임의 SP 호출의 토대).

---

## 3. 인증 설계 (확정: .env = 로그인ID + SK)
로그인마다 AK 가 바뀌므로 **.env 에는 로그인ID와 SK만** 둔다. 봇은 이 둘로 **최신 AK 를 DB에서 받아** giip API 를 호출한다.

### 3-1. 신규 관리자 API — `AdminGetAK` (login + SK → 최신 AK)
신규 SP `pApiAdminGetAKbyLoginSK`(byAK 규약, giipApi 디스패처로 자동 노출: `text=AdminGetAK`):
```
입력: @at = SK, @jsondata = { "uloginid": "<login>" }
1) SK 로 usn 도출: SELECT usn FROM tCorpUser WHERE uSecretKey=@sk AND uloginid=@uloginid  -- 로그인ID+SK 동시 일치(2요소)
   → 불일치면 401.
2) 최신 활성 AK 조회:
   SELECT TOP 1 AccToken FROM tUserLogin
   WHERE usn=@usn AND ulLogout IS NULL AND AccTokenRegdt > DATEADD(HOUR,-24,GETDATE())
   ORDER BY AccTokenRegdt DESC
3) (권장) 활성 AK 가 없으면 **새 AccToken 발급**:
   INSERT tUserLogin(usn, AccToken=NEWID(), AccTokenRegdt=GETDATE(), ...) → 그 토큰 반환
   → 이렇게 하면 최근 웹 로그인 없이도 .env(로그인+SK)만으로 자립.
반환: { ak, usn, csn }  (csn = 사용자 대표 프로젝트, 세션 스코프용)
```
- **왜 SK 직접 사용 안 하나(대안 비교)**: `lwGetUSNbyat` 는 SK 도 토큰으로 받으므로 *기술적으로는 SK 를 그대로 x-api-key 로 써도 byAK API 가 동작*한다(가장 단순, .env=SK 만). 그러나 (a) 동적 세션/CSN 컨텍스트가 없고 (b) SK 상시 노출·회수 어려움. → **로그인+SK→AK 방식 채택**(AK 자동 회전, 세션 스코프 확보). SK-직접은 폴백으로만.

### 3-2. 봇 설정 — Slack 채널별 계정 매핑 (확정)
채널마다 다른 프로젝트/계정을 쓸 수 있게 **채널 → {로그인ID, SK, csn}** 로 매핑한다. SK 는 비밀이므로 **비커밋 파일**에 둔다.
- 파일(비커밋, gitignore): `slack-bot/.secrets/giip-accounts.json` (샘플 `giip-accounts.sample.json` 만 커밋).
```jsonc
{
  "GIIP_API_BASE": "https://giipfaw.azurewebsites.net/api",
  "default": { "login_id": "<uloginid>", "sk": "<uSecretKey>", "csn": 47 },
  "channels": {
    "C0ABC123":  { "login_id": "<uloginid>", "sk": "<uSecretKey>", "csn": 47 },
    "C0XYZ789":  { "login_id": "<other>",    "sk": "<other_sk>",   "csn": 70 }
  }
}
```
- 해석 순서: 요청 채널 매핑 → 없으면 `default`.
- **AK 는 저장하지 않는다** (로그인마다 바뀜). 런타임에 각 계정의 (login_id+sk) 로 `AdminGetAK` 취득·캐시(만료/401 시 재취득). — [[rule 39]], workflow `giip-get-ak`.
- **.env 최소화**: 비밀은 위 파일에. (원하면 `default` 만 .env 로 둬도 됨.) **채널 계정 없이 default 만 쓰면 "로그인ID+SK만 있으면 됨" 그대로 성립.**

### 3-3. 대화로 계정 변경 → 설정 영속화 (확정)
Slack 대화에서 로그인ID/SK 를 바꾸면 위 매핑 파일을 **갱신·유지**한다.
- 커맨드(예): `giip account set <login_id> <sk> [csn]` — 실행 채널에 대한 매핑을 갱신. `giip account set-default ...` — default 갱신.
- 동작: `giip-accounts.json` 의 해당 채널(또는 default) 항목을 write → 다음부터 그 계정 사용. AK 캐시 무효화.
- **보안**: SK 가 평문 노출되므로 **DM 또는 비공개 채널 권장**. 설정 후 원문 메시지 삭제 안내. 파일은 gitignore(비커밋) — [[reference_giipdb_secrets_standard]].

### 3-3. AK 캐시/갱신
- 봇 메모리에 `{ak, fetchedAt}` 캐시. 매 호출 전 만료(예: 20h) 또는 401 수신 시 `AdminGetAK` 재호출.

### 3-4. 채널 → 기본 프로젝트 고정 (Channel Pin, task giip-724)
"이 채널의 대화는 모두 `<project>` 로 처리" 를 위한 **채널 → 프로젝트명** 고정 매핑. §3-2 의 계정(SK/csn) 매핑과는
**독립**이다(SK 비밀 없음 → **커밋**). csn 은 프로젝트명 → `project-csn.json` 으로 이미 해석되므로 여기서는 프로젝트명만 고정한다.
- 파일(커밋): `slack-bot/channel-project.json` `map`(`channelId → 프로젝트명`). 편집: Slack `giip channel set|list|del`(재시작 불필요).
- 적용: `processMessage` 에서 `config.applyChannelPin(channelId, parseProjectPrefix(text))`.
- **우선순위**: 명시적 프로젝트 접두어([[rule 32]]) > 채널 고정. 접두어가 없을 때만 채널 기본 프로젝트가 workDir/projectName(→csn)을 채운다.
- 기본값: `C0B5TV2T43S → ecokaku-aidc`(csn 70417). ⚠️ 봇 유저(uSn 29)가 그 csn 멤버여야 실제 라우팅됨(`giip project set` 이 자동 부여).

---

## 4. 태스크 ↔ giip issue 매핑 (통일)
| slack-bot(As-Is) | giip issue(To-Be) |
| :-- | :-- |
| taskId `YYYYMMDDHHMMSS` | **isn** (POST 생성 시 반환) |
| task 파일 request/제목 | issue **title** |
| 분석 계획 planContent | issue **content** (본문) |
| status: pending/running/completed/cancelled | issue **status** (giip issue 표준 그대로 사용): `PENDING`→`READY`→`IN_PROGRESS`→`REVIEW`→`DONE` |
| .agent/results/{id}.md 결과보고 | issue **코멘트**(giipIssueComments) |
| tasklist.json | giip issue **목록 API**(GET ?status=) — 로컬 인덱스 폐기 대상 |
| workflow 지정 | issue **agent_workflow** 필드 |
| 대상 서버 | **target_lssn** |

### giip issue 표준 status (확정: 이 집합만 사용, 커스텀 상태 신설 금지)
`PENDING`(에이전트 큐) → `READY`(머신 디스패치 준비) → `IN_PROGRESS`(실행중) → `REVIEW`(사람 확인 대기) → `DONE`(완료).
- 실측 정본: giipv3 `admin/giip-issues/[isn]/edit` status 드롭다운. (머신 디스패치는 별도 필드 `dispatch_status`.)
- **취소/실패 전용 상태는 없다** → 취소/실패는 **코멘트로 사유 기록 + status=`REVIEW`(사람 판단 대기)** 또는 `DONE`(종료)로 처리. 커스텀 상태를 만들지 않는다(사용자 결정 2026-07-11).

### 태스크 생성 우선순위 (확정, 2026-07-11)
대화에서 "태스크를 만들어야 한다"고 판단될 때:
1. **giip issue API 연결 가능** (계정 매핑 존재 + AK 취득 성공) → **giip issue 로 우선 등록**(POST /giipIssues → isn). 로컬 파일 생성 안 함(또는 미러만).
2. **미연결**(계정 없음/네트워크/AK 실패) → **기존 로컬 타임스탬프 태스크**(`getTimestampId` + `.agent/tasks/{id}.md`) 로 폴백(무중단).
- 즉 giip issue 를 SSOT 로 하되, 끊겨도 봇은 계속 동작(graceful degradation).

### 생명주기 (To-Be)
1. Slack 요청 수신 → 분석(planContent) → **POST /giipIssues**{title,content,status:`IN_PROGRESS`(즉시 실행) 또는 `PENDING`(큐),csn,agent_workflow} → **isn** 확보.
2. Slack 스레드에 `isn` 회신(태스크 번호 = isn 으로 통일). — 규칙: [[feedback_task_number_in_slack]]
3. subagent(claude CLI) 실행 → 완료 시 결과를 **코멘트**로 POST, **PUT status=`REVIEW`(사람 확인 필요) 또는 `DONE`(완료)**.
4. 재작업 요청(같은 isn 지정) → 해당 issue 에 코멘트 추가 + status 를 `IN_PROGRESS`로 재오픈(로컬 updateTaskFile 대체). — [[feedback_task_number_reuse]]

---

## 5. Slack 에서 모든 giip API 호출 (범용 게이트웨이)
- 신규 Slack 커맨드: `giip api <Verb> [jsondata]`
  - 예: `giip api DomainList {"csn":47}` → `giipApi` 디스패처(`text=DomainList`, jsondata) 호출, 결과 JSON 요약 회신.
  - 인증: §3 의 AK 자동첨부.
- issue 전용 단축 커맨드(선택): `giip issue new "<title>"`, `giip issue done <isn>`, `giip issue list [status]`.

---

## 6. 위험 / 가드
- ⚠️ **PUT 전체 덮어쓰기**([[reference_giip_issue_put_hazard]]): status 만 바꿀 때 title/content 유실 방지 → 봇은 **read(GET)→merge→PUT** 로 항상 전체 필드 채워 전송. (또는 status 전용 SP 신설 검토.)
- **SK 보안**: `.env`/`.secrets` 비커밋, gitignore 확인([[reference_giipdb_secrets_standard]]).
- **AK 발급 남용**: `AdminGetAK` 의 신규토큰 발급은 SK+로그인ID 2요소 일치일 때만. 로깅.
- **한글 인코딩**: giipfaw 함수/SP UTF-8([[reference_giipdb_sql_utf8_mojibake]]).
- **PUT/POST body 파싱**: giipDomainWhois#6 사례처럼 Hashtable/PSCustomObject 양쪽 처리 확인(giipIssues 는 이미 처리됨 L49).

## 7. 신규 개발물 (구현 단계에서)
1. **giipdb**: SP `pApiAdminGetAKbyLoginSK.sql` (§3-1). byAK 규약 → giipApi 로 자동 노출(함수 무수정).
2. **slack-bot**: `giip-accounts.js` — 채널별 계정 매핑 로드/저장(`.secrets/giip-accounts.json`), `resolve(channelId)→{login_id,sk,csn}`, `setAccount(channelId, ...)` 영속화. 샘플 `giip-accounts.sample.json` 커밋.
3. **slack-bot**: `giip-api.js` — { getAK(account), issueCreate, issueGet, issueUpdate, issueList, issueComment, apiCall(verb,jsondata) }. 계정별 AK 캐시 포함.
4. **slack-bot**: `task-manager.js` 리팩터 — 로컬파일 생명주기를 giip issue 호출로 대체(또는 §8 듀얼). csn 은 채널 매핑에서.
5. **slack-bot**: `index.js` — `giip api ...` / `giip issue ...` / `giip account set ...` 커맨드 라우팅, 회신에 isn 포함.
6. **gitignore**: `slack-bot/.secrets/giip-accounts.json` 비커밋 확인.

## 8. 마이그레이션 (단계)
- **P0 (본 문서)**: 설계 확정. ✅
- **P1**: ✅ **완료** — SP `pApiAdminGetAKbyAK`(라이브) + `giip-accounts.js`/`giip-api.js`/`giip-commands.js` + index.js 훅. `giip api`/`giip issue`/`giip account` 커맨드.
- **P2**: ✅ **완료** — `giip-task.js` + task-manager 등록/완료/에러 훅. 태스크 생성 시 연결이면 issue(IN_PROGRESS) 우선 등록·isn 회신, 완료/에러 시 코멘트+REVIEW. 미연결 시 로컬 폴백(rule 40). (수정요청(reuseTaskId) 재오픈은 P2.1 후속.)
- **P3**: **잔여 로컬 태스크 이관** — `.agent/tasks/`(및 `done/` 밖의 pending) 에 남은 태스크가 있으면 **giip issue 로 등록(POST) 후 로컬 파일은 done 처리**(`.agent/tasks/done/` 이동). 이관 완료 후 `tasklist.json`/`.agent/tasks` 는 미러 캐시로 강등(또는 폐기). 문서·규칙 갱신.
  - ⚠️ 이 이관은 P1(API 클라이언트 + 계정 자격증명) 이 갖춰진 뒤 실행 가능. 자격증명 없이는 등록 불가.

## 9. 결정 로그 (2026-07-11 사용자 확정)
1. ✅ **status 집합**: giip issue 표준 그대로 `PENDING/READY/IN_PROGRESS/REVIEW/DONE`. 커스텀(취소·실패) 상태 신설 안 함 → 코멘트+REVIEW/DONE 로 처리. (§4)
2. ✅ **AK 신규발급 허용**: 활성 AK 없으면 `AdminGetAK` 가 기존 로그인 처리처럼 **새 토큰 발급**해도 됨. (§3-1)
3. ✅ **csn/계정 = Slack 채널별 매핑**: 채널→{login_id, sk, csn}. SK 도 매핑. 대화로 변경 시 설정 파일 영속화. (§3-2·§3-3)
4. ✅ **로컬 `.agent/tasks` 처리 + 생성 우선순위**: 잔여 로컬 태스크는 **giip issue 등록 후 로컬 done** 처리(P3). 런타임 정책 = **giip issue 연결 시 우선 등록, 미연결 시 기존 타임스탬프 폴백**. (§4 "태스크 생성 우선순위", §8 P3)

**→ 설계(P0) 전 항목 확정 완료. 다음은 P1 구현.**

---
### 부록 A — 근거(실측 소스)
- 인증: `giipdb/Functions/lwGetUSNbyat.sql`(AK=tUserLogin.AccToken 24h / SK=tCorpUser.uSecretKey / fallback uaccesstoken), `SP/pApiUserLoginbyAK.sql`(→pUserLoginCheckGiip03).
- issue API: `giipfaw/giipIssues/run.ps1`, SP `pApiGiipIssue{Put,Get,List,Delete}byAK`.
- 봇 연동점: `slack-bot/task-manager.js`(getTimestampId/createTaskFile/startExecution/gitPushResult), `slack-bot/index.js`(L1510-1520).
