# 매시 이슈 처리 스케줄러 표준 스펙

giip issue 상태머신(PENDING→READY→IN_PROGRESS→REVIEW/DONE, +REVIEW→TESTED)을 매시 정해진 분에
무인으로 자동 처리하는 스케줄러의 **이식 가능한 표준 스펙**입니다. 여기가 **정본(canonical spec)**이며,
각 배포 대상(다른 PC, 다른 프로젝트, 다른 CSN)은 자기 경로만 채워 이 스펙을 그대로 참고/이식합니다.

원본 구현: `lowyworkenv/scripts/gissue/run-gissue-claude.ps1`(csn 47, giipprj 대상 실제 운영 인스턴스).
이 문서는 그 구현에서 플랫폼 종속 부분(절대경로, 이 PC 전용 계정)을 걷어내고 남긴 이식 가능한 뼈대입니다.

## 1) 목적/역할

- giip issue API를 CSN(고객사/프로젝트 식별자) 단위로 폴링해, 사람 개입 없이 이슈를 정제→실행→검증까지
  진행시킵니다.
- 목표는 "이슈가 등록된 뒤 방치되는 시간"을 없애는 것 — PENDING을 작업 지시서로 정제하고, READY를
  코드/문서 변경으로 실행하고, 멈춘 IN_PROGRESS를 회수하고, 실패한 PR을 고치고, REVIEW를 재검증합니다.
- CSN마다 별도 프로세스(또는 별도 -OnlyCsn 실행)로 격리되어, 서로 다른 프로젝트 폴더를 침범하지 않습니다.

## 2) 트리거 스펙

- **매시 :07** 시작(임의로 고른 분 — 정각/일반적인 :00, :05, :10 트리거들과 충돌을 피하기 위한 선택).
- cron 표현식(다른 플랫폼/Linux 참고용): `7 * * * *`
- Windows Task Scheduler 기준: 최초 트리거 `00:07:00` 시작, `1시간마다 반복`, 사실상 무기한 지속
  (`[TimeSpan]::MaxValue`는 ISO8601 직렬화 시 Task Scheduler XML의 duration 상한을 초과해
  `Register-ScheduledTask`가 거부하므로(HRESULT 0x80041318, giip #1275), 실제로는 유효 범위 내
  충분히 큰 값 — 약 10년(`New-TimeSpan -Days 3650`) — 을 사용).

## 3) 실행 커맨드 템플릿

```powershell
powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass `
  -File "<REPO_ROOT>/scripts/gissue/run-gissue-claude.ps1"
```

- `<REPO_ROOT>`: 이 스케줄러 스크립트 세트를 배치한 오케스트레이션 레포의 루트(원본 배포에서는
  lowyworkenv).
- 단일 CSN만 즉시 실행/드라이런하려면 `-OnlyCsn <csn>` 인자를 추가합니다(`-DryRun`과 조합 가능).
- Windows Task Scheduler 대신 cron/systemd timer 등 다른 스케줄러로 이식할 경우, 이 커맨드 자체를
  그대로 그 스케줄러의 실행 대상으로 등록하면 됩니다(플랫폼별 셸 래퍼만 다르면 됨).

## 4) 필수 선행조건

- **CSN→프로젝트 매핑 파일** (`scripts/gissue/csn-projects.json`, `csn-projects.json.example`을
  복사해 실제값 채움 — gitignore 대상): 각 CSN을 어느 로컬 프로젝트 폴더에서 처리할지 매핑.
  `enabled: false`인 CSN은 자동 실행에서 건너뜁니다. 새 CSN을 추가하려면 이 파일에 항목 1개를
  추가하면 됩니다. **`restBranch`(선택)**: 이 프로젝트의 상시 작업 브랜치가 git 원격의 기본
  브랜치(main/master)와 다르면(예: dev-first 원칙으로 `dev`가 상시 작업 브랜치인 프로젝트) 반드시
  지정합니다 — 안 그러면 busy-check가 이를 매번 "다른 프로세스가 쓰는 중"으로 오판해 30분 대기 후
  강제 언블록(stash+base 체크아웃)을 매 `:07`마다 반복합니다(실측 확인·재현).
- **giip issue API 접근용 SK(Secret Key)**: CSN별 계정 SK가 필요합니다(`slack-bot/.secrets/
  giip-accounts.json`의 `channels[*].sk`를 CSN으로 매칭해 조회, `.sample.json`을 복사해 준비). 이
  파일은 git 비추적 시크릿이므로 배포 대상마다 별도로 준비해야 합니다.
- **AI 엔진 키**: 이 스케줄러는 이슈 처리 본체를 `claude -p`(헤드리스, 컨펌 없이 자율 실행)로
  실행합니다. `MINIMAX_API_KEY`가 있으면 MiniMax를 우선 시도하고, 실패/한도 초과 시 같은 실행
  안에서 즉시 `claude`로 폴백합니다(키가 없으면 기존처럼 항상 claude만 사용).
- **로그 디렉터리**: `scripts/gissue/logs/`에 CSN별 로그(`gissue_csn<csn>.log`)와 lock 파일을
  남깁니다(gitignore 대상, 자동 생성).
- **giip issue 조회/코멘트/상태변경 도구(이 레포에 기본 내장, DB 직접 접근 불필요)**:
  `scripts/gissue/list-issues.js`(CSN+상태별 이슈 목록 조회, giipfaw API 경유)와
  `scripts/gissue/get-issue.sh --comment-file`/`--status`(단건 조회/코멘트/상태전이)를 그대로 쓰면
  됩니다. CSN 교차오염 방지 게이트(giip #1053/#1079)가 내장돼 있어 별도 조치가 필요 없습니다.
  한글/이모지가 섞인 코멘트 본문은 반드시 UTF-8 파일로 저장한 뒤 파일 경로(`--comment-file`)로
  전달해야 합니다(커맨드라인 리터럴 직접 전달은 headless 실행 체인에서 시스템 기본 코드페이지로
  mojibake가 나는 사고가 재현 확인됨, giip #1030). 이 두 도구가 없는 프로젝트(예: `giipprj`처럼
  DB 직접 접근용 `giipdb/mgmt/*.ps1`만 있는 배포)를 이식할 때는, 그 DB-direct 스크립트들을 그대로
  재사용해도 되고, 이 두 API 기반 도구로 교체해도 됩니다 — 단 **혼용 이식은 금지**: 프롬프트 템플릿의
  이슈 조회/쓰기 커맨드가 실제로 그 프로젝트에 존재하는 도구를 가리키는지 이식 후 반드시
  `-DryRun`으로 확인합니다(존재하지 않는 경로를 참조하면 매 실행이 그 단계에서 조용히 실패합니다).

## 5) 상태머신 개요 (8단계)

매 :07 실행마다 아래 순서로 수행합니다(원본 프롬프트 템플릿의 `[0]`, `[A]`~`[H]` 대응):

| 단계 | 이름 | 한 줄 요약 |
|---|---|---|
| [0] | PR conflict 우선 해결 | 이슈 처리 착수 전, 담당 프로젝트(+nested repo)의 열려있고 conflict 난 PR을 먼저 해소 |
| [A] | 슬래시 커맨드 즉시 실행 | 제목/본문/최신 코멘트가 `/`로 시작하면 상태·나이 무관하게 즉시 해당 워크플로우 기동 |
| [B] | PENDING 정제 | 내용을 분석해 작업 지시서 코멘트를 남기고 READY로 전이(실행까지는 안 함) |
| [C] | READY 실행 | READY로 1시간 이상 경과한 것만, IN_PROGRESS로 선점 후 실제 처리(PR 완료 게이트 + Actionflow 테스트 게이트 통과 시 DONE) |
| [D] | IN_PROGRESS 회수(reclaim) | 1시간 이상 활동 없는 IN_PROGRESS를 원인 분석 후 이어받아 완수 — 죽은/멈춘 세션 복구 |
| [E] | PR CI 실패 점검 | 이슈 유무와 무관하게 매번, 열린 PR 중 CI/검증 실패한 것을 원인 규명 후 로컬 재검증 통과 시에만 수정 push |
| [F] | Orphan stash 구조 | 이전 실행이 안전하게 stash해둔 "죽은 세션 잔해"를 이슈와 매칭시켜 구조(확신 없으면 사람에게 위임) |
| [G] | REVIEW 재검증 | REVIEW 이슈를 Actionflow로 재테스트해 SUCCESS면 TESTED로(자동 DONE은 하지 않음 — 최종 종결은 사람) |
| [H] | 최근 코멘트 논리 재검증 | 최근 2시간 내 코멘트의 "검증 가능한 사실 주장"을 직접 재확인해, 틀렸으면 정정 코멘트+상태 복구 |

각 단계 상세 규칙(선점/코멘트 프로토콜, 3회 defer 상한, PR 완료 게이트, Actionflow 테스트 게이트 등)은
이 레포 `scripts/gissue/run-gissue-claude.ps1`의 `$PromptTemplate` 전문을 참고합니다(본문 복제
금지 — 상세 로직이 자주 갱신되므로 이 문서는 개요만 유지). Actionflow 테스트 게이트는 프로젝트
자체 Actionflow 스크립트가 있으면 그것을, 없으면(대부분의 배포) HTTP_CHECK을 직접 재현하는 방식으로
자동 폴백합니다 — SQL_CHECK이 필요한데 DB 접근 수단이 없으면 자동 DONE 대신 REVIEW로 넘깁니다.

## 6) 절대 규칙 — 성역(sanctuary) 보호

이 스케줄러가 처리하는 프로젝트 중 하나 이상에 **절대 코드 수정 금지 성역**이 존재할 수 있습니다.
원본 배포의 대표 사례: `giipfaw`(및 그 하위 `giipApiSk2/run.ps1`)는 어떤 이유로도 스케줄러가 직접
수정하지 않습니다 — 필요한 로직 변경은 SP(저장 프로시저)나 프로젝트 코드 내에서만 해결합니다.

이식 시 반드시 확인할 것:
- 이 배포 대상이 처리할 CSN/프로젝트 각각에 성역 파일/디렉터리가 있는지 사전 조사(CSN→프로젝트
  매핑 파일의 `note` 필드에 프로젝트별 성역 여부를 기록하는 관례를 따르는 것을 권장합니다).
- 성역이 있으면, 해당 파일 수정이 불가피한 이슈는 자동 처리를 포기하고 REVIEW로 전이 +
  "성역 파일 수정 필요, 사람 확인 요청" 코멘트로 넘기도록 CSN별 규칙에 명시합니다.
- 강제 언블록(정지된 브랜치 자동 해제) 로직을 이식할 경우, 성역 레포는 그 대상에서 제외해야
  합니다 — 병합 여부가 불확실한 상태에서 성역 레포를 강제로 건드리는 것보다, 경고+코멘트 후
  포기하는 경로가 더 안전하다는 것이 원본의 판단 근거입니다.

## 7) 정본 위치

이 문서(`giip-fde-agent/docs/60-operations/hourly-issue-scheduler.md`)가 이 스케줄러 표준의
**정본**입니다. 다른 배포 대상(다른 PC, 다른 레포)은 이 문서를 참고해 자기 환경에 맞게 이식하되,
이 문서 자체를 각자 복제해 따로 관리하지 말고 이 경로를 가리키는 포인터만 남기는 것을 권장합니다.

등록 스크립트: `giip-fde-agent/scripts/register-hourly-issue-scheduler.ps1`(파라미터화된 Windows
Task Scheduler 등록 스크립트, 이 문서의 §2~§3 스펙을 그대로 구현).

## 8) 배포 절차(신규 CSN/PC — 복사만으로 이식)

이 레포 자체가 이제 실행 가능한 구현체입니다(스펙 문서만이 아님). 새 프로젝트/PC에 이식하려면:

1. 이 레포(`giip-fde-agent`)를 그 PC에 clone(또는 이미 있으면 pull).
2. `scripts/gissue/csn-projects.json.example`을 `csn-projects.json`으로 복사 후 자기 CSN/워크디렉터리
   (+필요시 `restBranch`)만 채운다.
3. `slack-bot/.secrets/giip-accounts.sample.json`을 `giip-accounts.json`으로 복사 후 실제 SK를 채운다.
4. `-DryRun -OnlyCsn <csn>`으로 먼저 실행해 워크디렉터리 인식·SK 해석·busy-check(BUSY 오판 없음)·엔진
   선택까지 로그로 확인한다(실제 claude 미기동).
5. 문제 없으면 `register-hourly-issue-scheduler.ps1 -Action Register -RepoRoot <이 clone 경로>`로
   Windows 스케줄러에 등록한다(태스크 이름은 배포 대상마다 고유하게 `-TaskName`으로 지정).

**주의**: 스케줄러가 처리할 workdir가 사람이 대화형으로 동시에 쓰는 작업 폴더와 같으면, `restBranch`를
지정해도 busy-check의 "다른 세션이 지금 쓰는 중" 신호와 실제 사람의 동시 작업을 근본적으로 구분할
수 없어, 사람이 작업 중인 워킹트리에 강제 언블록(stash+체크아웃)이 실행될 위험이 남는다. 대화형으로도
자주 쓰는 저장소라면, 스케줄러 전용 별도 clone을 workdir로 쓰는 것을 권장한다(원본 저장소와는 git
remote로만 연결된, 완전히 독립적인 워킹트리).

## 8) 연결 문서

- KPI 표준: `./ai-native-kpi.md`
- 장애/롤백 플레이북: `./incident-rollback-playbook.md`
- 원본 운영 인스턴스 제어법(이 PC 전용): `lowyworkenv/scripts/gissue/SCHEDULER_CONTROL.md`
