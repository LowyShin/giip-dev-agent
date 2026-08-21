# pr-gate-sweep.ps1 — PR 완료 게이트 강제 후처리 (giip #1077)
#
# 배경(giip #1077): run-gissue-claude.ps1 의 PR 완료 게이트("어느 레포든 PR이 안 됐으면
#   REVIEW 가 아니라 READY 로 되돌려 다음 :07 이 이어받게 함")는 지금까지 claude 프롬프트의
#   자유서술 지시였을 뿐이라, 세션(특히 MiniMax 엔진 세션)이 git commit/push/PR 단계에 도달하기
#   전에 조기 종료하면서 그 지시를 무시하고 이슈를 REVIEW 로 전이하면(#1042/#1074 사례) 아무도
#   재시도하지 않아 완전히 방치됐다([C]는 READY≥1h, [D]는 stale IN_PROGRESS, [G]는 Actionflow
#   코멘트 없는 REVIEW 만 대상이라 "PR 0개 REVIEW"는 어느 큐에도 안 걸림).
#
# 이 스크립트는 그 게이트를 자유서술이 아니라 "세션 종료 후 스크립트가 강제로 재검증"하는
#   후처리 단계로 승격한다. 각 :07 실행이 CSN 잡을 마친 뒤 이 스윕을 돌리면, REVIEW 큐 안에서
#   nested repo 에 대응 PR(브랜치 `bot/task-giip-<isn>`)이 하나도 없는 이슈를 찾아 READY 로
#   되돌린다 → 다음 :07 [C] 가 이어받아 PR 까지 완수한다. (이미 REVIEW 에 방치된 것도 매 실행
#   스윕으로 회수되므로 giip #1077 조치 3번의 "1회성 정리"도 이 스크립트가 상시 담당한다.)
#
# 안전 설계:
#   - REVIEW 만 대상. DONE 은 절대 건드리지 않는다(투자/조사/코멘트-답변으로 정당하게 PR 없이
#     DONE 되는 경우가 흔해, DONE 자동 재오픈은 위조-DONE 을 잡는 이득보다 오탐 피해가 크다).
#   - 무한 왕복 방지(loop guard): 이미 이 스크립트가 `[PR-GATE-REVERT]` 되돌림 코멘트를 한 번
#     남긴 이슈는 다시 되돌리지 않고 REVIEW 로 둔다(사람 판단으로 넘김). 즉 자동 되돌림은
#     이슈당 최대 1회 — 정당한 "PR 불필요(설계 결정)" REVIEW 도 딱 한 번만 튕겼다가, 다음
#     세션이 "PR 불필요 사유"를 명시적으로 다시 REVIEW 로 남기면 그대로 유지된다.
#   - PR 존재 판정은 오탐(불필요한 되돌림)을 줄이기 위해 넉넉하게: 정확한 head 브랜치
#     `bot/task-giip-<isn>` 매치 OR 넓은 검색(`giip-<isn>`)에서 브랜치/제목이 그 isn 을 담으면
#     "PR 있음"으로 본다.
#
# 2026-08-18(giip #1210): 위 loop guard/PR 존재 판정은 "PR 이 존재하는가"만 확인할 뿐, 그 PR 이
#   실제로 신고된 증상을 고쳤는지, 진행/테스트/검증 코멘트가 프로토콜대로 남았는지는 전혀 검증하지
#   않는다는 구조적 허점이 실측됐다(giip #1195: 무관한 파일 3줄만 고친 PR #545 가 게이트 통과 /
#   giip #1208: PR #546 은 정상 병합됐지만 진행 코멘트가 이슈에 단 하나도 없이 REVIEW 로 감).
#   그래서 Test-IssueHasPr 가 true 인 이슈에 대해서만 이어서 두 단계를 추가한다(모두
#   gissue-audit-lib.ps1 에 정의):
#     1) scope-match — PR 의 실제 diff 와 이슈 content+코멘트를 경량 LLM(claude-haiku-4-5, 도구
#        접근 없는 순수 텍스트 판정)에 넘겨 MATCH/MISMATCH 를 받는다. MISMATCH 면 `[SCOPE-GATE-REVERT]`
#        마커로 REVIEW→READY.
#     2) comment-gate — scope-match 가 MATCH 인 경우에만, 이슈 코멘트 이력에 착수/테스트결과/
#        사용자검증방법 코멘트가 실제로 있는지 같은 방식으로 판정한다. 미충족이면
#        `[COMMENT-GATE-REVERT]` 마커로 REVIEW→READY(코드는 정상이니 코멘트만 보완하라는 취지 명시).
#   두 마커 모두 기존 `[PR-GATE-REVERT]` 와 완전히 독립된 loop guard(이슈당 각각 최대 1회)다.
#   판정 호출이 실패/차단되면 안전하게 기존 동작(PR 있음 → REVIEW 유지)으로 폴백하고 WARN 로그만
#   남긴다(스케줄러를 절대 막지 않는다). 판정 호출 구현 패턴(플래그 조합/인젝션 방어/인코딩)은
#   giip #1204(PR #572)에서 이미 확립된 것을 그대로 재사용한다 — gissue-audit-lib.ps1 의
#   Invoke-GissueJudge 주석 참고.
#
# 2026-08-15(giip #1123 조사 중 발견, 회귀 버그 수정): REVIEW 큐 조회 응답 파싱이 실제 API 응답
#   모양 `{"issues":[...]}` 의 `.issues` 프로퍼티를 확인하지 않고 있었다(array/.data/.Table 만 체크
#   → 전부 불일치 시 `@($response)`로 전체 응답객체 하나를 배열로 감싸 반환, 그 객체엔 `.isn`이 없어
#   이후 Where-Object 필터가 100% 무조건 0건으로 떨어짐). 즉 이 스크립트는 배포 이후 REVIEW 이슈가
#   실제로 몇 건 있었든 상관없이 "대상 REVIEW 이슈 없음"만 보고해왔을 가능성이 있다 — giip #1123 이
#   "REVIEW 큐가 비어있어 revert 경로가 한 번도 실관찰되지 못했다"고 적은 원인이 실은 "큐가 정말
#   비어 있었다"가 아니라 "이 파싱 버그로 항상 0건으로 보였다"였을 가능성을 배제할 수 없다. `.issues`
#   분기를 추가해 수정했다(review-done-audit.ps1 조사 중 실제 DONE 872건 응답으로 재현 확인).
#
# 사용:
#   # 스케줄러가 세션 종료 후 자동 호출(run-gissue-claude.ps1 Complete-Run 에서)
#   powershell -File pr-gate-sweep.ps1 -Csn 47 -Workdir "C:\...\giipprj" -ApiKey <SK>
#   # 수동/드라이런(되돌림 없이 판정만)
#   powershell -File pr-gate-sweep.ps1 -Csn 47 -Workdir "C:\...\giipprj" -ApiKey <SK> -DryRun
#   # 단일 이슈 PR 존재 진단(상태 변경 없음 — 테스트용)
#   powershell -File pr-gate-sweep.ps1 -Workdir "C:\...\giipprj" -DiagnoseIsn 1076
param(
    [int]$Csn = 0,
    [Parameter(Mandatory = $true)][string]$Workdir,
    [string]$ApiKey,
    [string]$MgmtDir,
    [string]$ApiBaseUrl = "https://giipfaw.azurewebsites.net/api",
    [int]$DiagnoseIsn = 0,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# [ENCODING][giip #1210 -DryRun 실측 중 발견] scope-match/comment-gate 판정(gissue-audit-lib.ps1의
# Invoke-GissueJudge)이 `$prompt | & claude -p ...` stdin 파이프로 한글이 대부분인 이슈 content/코멘트를
# 넘긴다. 이 스크립트는(run-gissue-claude.ps1 과 달리) Start-Job 없이 `powershell -File` 로 직접 실행되므로
# PowerShell 5.1 기본 콘솔 코드페이지(949)로 인코딩되어 claude 가 "ENCODING_ERROR" 로 응답하는 것을 csn 47
# -DryRun 실행에서 실측했다(giip #1204 버그 B와 동일 원인 계열). run-gissue-claude.ps1 상단과 동일하게
# UTF-8 로 명시 고정한다.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$RevertMarker = '[PR-GATE-REVERT]'
$RevertAuthor = 'gissue-pr-gate'

# giip #1210: PR 존재 확인(Test-IssueHasPr) 뒤에 이어지는 두 단계 추가 판정용 마커/작성자.
# 기존 [PR-GATE-REVERT] 와 완전히 독립된 loop guard(이슈당 각각 최대 1회) — 배경/설계는
# gissue-audit-lib.ps1 상단 "giip #1210" 주석 및 이슈 본문 참고.
$ScopeRevertMarker = '[SCOPE-GATE-REVERT]'
$ScopeRevertAuthor = 'gissue-scope-gate'
$CommentRevertMarker = '[COMMENT-GATE-REVERT]'
$CommentRevertAuthor = 'gissue-comment-gate'

# PR-존재 판정(Get-NestedRepoPaths/Test-IssueHasPr) + 코멘트 조회(Get-IssueComments) 공유 로직은
# gissue-audit-lib.ps1 로 분리됐다(giip #1123, review-done-audit.ps1 이 동일 로직을 재사용하기 위함).
# 동작은 기존과 100% 동일 — 함수 정의 위치만 옮겼다.
. (Join-Path $PSScriptRoot 'gissue-audit-lib.ps1')

function Write-SweepLog($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Output "[$ts] [pr-gate-sweep] $msg"
}

# 이 이슈가 이미 [PR-GATE-REVERT] 로 한 번 되돌려졌는가(loop guard).
# [giipfaw API 경유 주의] author 는 클라이언트가 지정할 수 없어(gissue-audit-lib.ps1 상단 주석 참고)
# 마커 문자열만으로 판별한다.
function Test-AlreadyReverted($isn) {
    foreach ($c in (Get-IssueComments $isn $ApiKey $ApiBaseUrl)) {
        if ($c.content -and $c.content.Contains($RevertMarker)) { return $true }
    }
    return $false
}

# REVIEW→READY 되돌림 실행 공통부(giipfaw API 경유) — 코멘트 등록 + 상태변경.
function Invoke-GissueReadyRevert($isn, $note) {
    $tmp = Join-Path $env:TEMP ("gissue_prgate_note_{0}_{1}.txt" -f $isn, [guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($tmp, $note, (New-Object System.Text.UTF8Encoding $true))
        & node (Join-Path $PSScriptRoot 'lib\post-comment.js') $isn "@$tmp" $ApiKey $ApiBaseUrl 'note' 2>&1 | Out-Null
        Invoke-RestMethod -Uri "$ApiBaseUrl/giipIssues" -Method Put -Body (@{ isn = $isn; status = 'READY' } | ConvertTo-Json -Compress) -ContentType 'application/json' -Headers @{ 'x-api-key' = $ApiKey } | Out-Null
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Revert($isn) {
    $note = @"
$RevertMarker (재검증 시각: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
gissue 스케줄러의 PR 완료 게이트 강제 후처리(giip #1077)가 이 이슈를 REVIEW → READY 로 되돌렸습니다.
사유: 이 이슈에 대응하는 PR(브랜치 `bot/task-giip-$isn`)이 담당 nested 레포 어디에도 없습니다.
세션이 코드 수정까지만 하고 커밋/push/PR 단계 전에 종료됐을 때(예: 엔진 조기 종료) 발생하는
"PR 미완료인데 REVIEW 방치" 패턴입니다. 다음 :07 실행이 이어받아 PR 까지 완수합니다.

만약 PR 이 필요 없는 이슈(설계 결정·조사·코멘트 답변 등)라면, 다음 세션에서 "PR 불필요 사유"를
명시적으로 남기고 다시 REVIEW 로 두세요 — 그 경우 이 자동 되돌림은 이슈당 1회만 동작하므로
다시 튕기지 않습니다.
"@
    if ($DryRun) {
        Write-SweepLog "[DRYRUN] REVERT isn=$isn REVIEW→READY (PR 없음)"
        return
    }
    Invoke-GissueReadyRevert $isn $note
    Write-SweepLog "REVERTED isn=$isn REVIEW→READY (PR 없음) + note 등록"
}

# 공통 되돌림 실행기(giip #1210) — Invoke-Revert 와 같은 패턴(REVIEW→READY, note 코멘트, DryRun 로그만)
# 이되, 마커/작성자/본문을 scope-gate 와 comment-gate 가 각자 넘긴다.
function Invoke-GateRevert($isn, $marker, $author, $note, $logLabel) {
    if ($DryRun) {
        Write-SweepLog "[DRYRUN] REVERT isn=$isn REVIEW→READY ($logLabel)"
        return
    }
    Invoke-GissueReadyRevert $isn $note
    Write-SweepLog "REVERTED isn=$isn REVIEW→READY ($logLabel) + note 등록"
}

function Invoke-ScopeRevert($isn, $prInfo, $rationale) {
    $note = @"
$ScopeRevertMarker (재검증 시각: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
gissue 스케줄러의 scope-match 판정 게이트(giip #1210)가 이 이슈를 REVIEW → READY 로 되돌렸습니다.
사유: PR #$($prInfo.number)($($prInfo.url))의 실제 변경 내용이 이 이슈에서 신고된 증상과 무관하거나
신고 범위보다 훨씬 좁은/다른 것을 고친 것으로 판정되었습니다(giip #1195 실증 패턴 — 무관한 파일의
사소한 수정만으로 "해결됨" 처리되는 스코프 이탈 방지).

판정 근거(LLM 판정 응답):
$rationale

원래 신고된 증상을 실제로 다루는 수정으로 다시 진행한 뒤 새 PR(또는 같은 PR 갱신)을 내면 다음 :07
실행이 이어받아 재검증합니다. 이 되돌림은 이슈당 1회만 동작합니다(loop guard) — 제대로 고쳐서 다시
REVIEW 로 오면 다시 튕기지 않습니다.
"@
    Invoke-GateRevert $isn $ScopeRevertMarker $ScopeRevertAuthor $note "scope-match MISMATCH"
}

function Invoke-CommentRevert($isn, $prInfo, $rationale) {
    $note = @"
$CommentRevertMarker (재검증 시각: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
gissue 스케줄러의 comment-gate 판정(giip #1210)이 이 이슈를 REVIEW → READY 로 되돌렸습니다.

**중요: PR/코드는 정상입니다 — 다시 고치라는 뜻이 아닙니다.** PR #$($prInfo.number)($($prInfo.url))이
실제로 존재하고, scope-match 판정도 이미 통과했습니다(=이 PR 이 신고된 증상을 실제로 다룬다는 뜻).
다만 이 이슈의 코멘트 이력에 [진행 코멘트 프로토콜]이 요구하는 착수/테스트결과/사용자검증방법 코멘트가
실제로 등록되어 있지 않은 것으로 판정되었습니다(giip #1208 실증 패턴 — 코드는 정상 병합됐지만 진행
코멘트가 하나도 없이 REVIEW 로 감).

판정 근거(LLM 판정 응답):
$rationale

**코멘트 프로토콜만 보완하면 됩니다.** 코드를 다시 고치거나 PR을 다시 낼 필요 없이, 누락된 착수/
테스트결과/사용자검증방법 코멘트를 등록한 뒤 다시 REVIEW 로 전이하십시오. 이 되돌림은 이슈당 1회만
동작합니다(loop guard) — 코멘트만 보완해 REVIEW 로 복귀하면 다시 튕기지 않습니다.
"@
    Invoke-GateRevert $isn $CommentRevertMarker $CommentRevertAuthor $note "comment-gate UNSATISFIED"
}

# ── 진단 모드: 단일 isn 의 PR 존재 여부만 출력(상태 변경 없음) ──
if ($DiagnoseIsn -gt 0) {
    $repos = Get-NestedRepoPaths $Workdir
    Write-SweepLog "진단: isn=$DiagnoseIsn, repos=$(@($repos | ForEach-Object { Split-Path -Leaf $_ }) -join ',')"
    $has = Test-IssueHasPr $DiagnoseIsn $repos
    Write-SweepLog "isn=$DiagnoseIsn hasPR=$has"
    return
}

# ── 스윕 모드 ──
if (-not $ApiKey) { throw "ApiKey(SK) 가 필요합니다 — REVIEW 큐 조회용." }
if ($Csn -le 0) { throw "Csn 이 필요합니다." }

$repos = Get-NestedRepoPaths $Workdir
Write-SweepLog "시작: Csn=$Csn, repos=$(@($repos | ForEach-Object { Split-Path -Leaf $_ }) -join ',')$(if($DryRun){' [DRYRUN]'})"

# REVIEW 큐 조회(direct API — listReviewIssues.ps1 과 동일 정규화).
# Invoke-GiipApiGet(gissue-audit-lib.ps1) 사용 — Invoke-RestMethod 직접 호출 시 PS5.1 인코딩 버그로
# 한글이 깨지는 문제가 review-done-audit.ps1 조사 중 발견됐다(giip #1123). 이 스크립트는 지금까지
# 이슈 제목의 한글 비교/로그 출력에 의존하지 않아 실질적 영향은 없었지만, 일관성을 위해 통일한다.
$uri = "$ApiBaseUrl/giipIssues?status=REVIEW&csn=$Csn"
try {
    $response = Invoke-GiipApiGet $uri $ApiKey
} catch {
    Write-SweepLog "REVIEW 조회 실패: $($_.Exception.Message)"
    return
}
if ($response -is [array]) { $issues = $response }
elseif ($response.issues) { $issues = $response.issues }   # 실측 응답 모양(giip #1123 조사 중 발견) — {"issues":[...]}
elseif ($response.data) { $issues = $response.data }
elseif ($response.Table) { $issues = $response.Table }
else { $issues = @($response) }
$issues = @($issues | Where-Object {
    $csnValue = if ($_.cSn -ne $null) { $_.cSn } elseif ($_.csn -ne $null) { $_.csn } else { $null }
    (-not $_.status -or $_.status -eq 'REVIEW') -and ($csnValue -eq $Csn) -and $_.isn
})

if (@($issues).Count -eq 0) { Write-SweepLog "대상 REVIEW 이슈 없음 — 종료."; return }
Write-SweepLog "REVIEW 이슈 $(@($issues).Count)건 검사."

$reverted = 0; $keptHasPr = 0; $keptGuard = 0
$scopeReverted = 0; $scopeGuard = 0; $commentReverted = 0; $commentGuard = 0; $gateWarn = 0
foreach ($iss in $issues) {
    $isn = [int]$iss.isn
    if (-not (Test-IssueHasPr $isn $repos)) {
        if (Test-AlreadyReverted $isn) {
            $keptGuard++
            Write-SweepLog "isn=${isn}: PR 없지만 이미 1회 되돌림($RevertMarker) → loop guard, REVIEW 유지(사람 판단)."
        } else {
            Invoke-Revert $isn
            $reverted++
        }
        continue
    }
    $keptHasPr++

    # ── giip #1210: scope-match / comment-gate 2단계 추가 판정 ──
    # PR 이 존재하는 것으로 확인된 이슈에 대해서만 진행한다. 판정 호출 자체가 실패/차단되면
    # 안전하게 기존 동작(PR 있음 → REVIEW 유지)으로 폴백하고 WARN 로그만 남긴다(이슈 본문 명시 요구).
    $prInfo = Get-IssuePrInfo $isn $repos
    if (-not $prInfo) {
        $gateWarn++
        Write-SweepLog "isn=${isn}: PR 있음으로 판정됐지만 상세 조회 실패 → scope/comment 게이트 생략, REVIEW 유지(안전 폴백)."
        continue
    }

    if (Test-AlreadyRevertedByMarker $isn $ScopeRevertMarker $ScopeRevertAuthor $ApiKey $ApiBaseUrl) {
        $scopeGuard++
        Write-SweepLog "isn=${isn}: 이미 1회 scope-gate 되돌림($ScopeRevertMarker) → loop guard, REVIEW 유지(사람 판단)."
        continue
    }

    $issueDetail = Get-IssueDetail $isn $ApiKey $ApiBaseUrl
    $comments = Get-IssueComments $isn $ApiKey $ApiBaseUrl
    $commentsText = ConvertTo-CommentsText $comments
    $prDiff = Get-PrDiffSummary $prInfo.repo $prInfo.number
    $issueContent = if ($issueDetail -and $issueDetail.content) { $issueDetail.content } else { '' }

    $scopeJudge = Invoke-ScopeMatchJudge $isn $issueContent $commentsText $prInfo $prDiff
    if (-not $scopeJudge.ok) {
        $gateWarn++
        Write-SweepLog "isn=${isn}: scope-match 판정 호출 실패/차단(exit=$($scopeJudge.exit)) → 안전 폴백, REVIEW 유지."
        continue
    }
    $scopeVerdict = Get-JudgeVerdict $scopeJudge.text 'MATCH' 'MISMATCH'
    if ($scopeVerdict -eq 'MISMATCH') {
        Write-SweepLog "isn=${isn}: scope-match MISMATCH → REVERT."
        Invoke-ScopeRevert $isn $prInfo $scopeJudge.text
        $scopeReverted++
        continue
    } elseif ($scopeVerdict -ne 'MATCH') {
        $gateWarn++
        Write-SweepLog "isn=${isn}: scope-match 판정 응답 모호('$($scopeJudge.text)') → 안전 폴백, REVIEW 유지."
        continue
    }
    Write-SweepLog "isn=${isn}: scope-match MATCH → comment-gate 판정 진행."

    if (Test-AlreadyRevertedByMarker $isn $CommentRevertMarker $CommentRevertAuthor $ApiKey $ApiBaseUrl) {
        $commentGuard++
        Write-SweepLog "isn=${isn}: 이미 1회 comment-gate 되돌림($CommentRevertMarker) → loop guard, REVIEW 유지(사람 판단)."
        continue
    }

    $commentJudge = Invoke-CommentGateJudge $isn $commentsText
    if (-not $commentJudge.ok) {
        $gateWarn++
        Write-SweepLog "isn=${isn}: comment-gate 판정 호출 실패/차단(exit=$($commentJudge.exit)) → 안전 폴백, REVIEW 유지."
        continue
    }
    $commentVerdict = Get-JudgeVerdict $commentJudge.text 'SATISFIED' 'UNSATISFIED'
    if ($commentVerdict -eq 'UNSATISFIED') {
        Write-SweepLog "isn=${isn}: comment-gate UNSATISFIED → REVERT."
        Invoke-CommentRevert $isn $prInfo $commentJudge.text
        $commentReverted++
        continue
    } elseif ($commentVerdict -ne 'SATISFIED') {
        $gateWarn++
        Write-SweepLog "isn=${isn}: comment-gate 판정 응답 모호('$($commentJudge.text)') → 안전 폴백, REVIEW 유지."
        continue
    }
    Write-SweepLog "isn=${isn}: scope-match MATCH + comment-gate SATISFIED → REVIEW 유지([G] Actionflow 재검증 대상)."
}
Write-SweepLog "완료: PR없음-되돌림 $reverted, PR있음 $keptHasPr, PR없음-guard유지 $keptGuard, scope-되돌림 $scopeReverted, scope-guard유지 $scopeGuard, comment-되돌림 $commentReverted, comment-guard유지 $commentGuard, 게이트경고(폴백) $gateWarn."
