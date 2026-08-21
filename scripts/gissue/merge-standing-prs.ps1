# merge-standing-prs.ps1 — 지정된 레포 목록의 "열려있고 깨끗하게 머지 가능한" PR을 자동 머지한다.
#
# 목적: 매시 :07 gissue 스케줄러 실행의 "가장 첫 동작"으로, run-gissue-claude.ps1 이 이 실행의
# csn-projects.json 에 등록된 모든 workdir 를 -RepoPaths 로 넘겨 호출한다. 그 레포들에 열려있는
# GitHub PR 중 mergeable=MERGEABLE(충돌 없음, 검사 통과)인 것을 즉시 squash 머지해, PR이 리뷰
# 없이 쌓이는 것을 방지하는 안전망이다.
#
# 이 스크립트는 어떤 레포에서도 코드를 작성/수정하지 않는다 — `gh pr list`/`gh pr merge` 로 GitHub
# API 를 통해서만 동작하며 로컬 체크아웃/브랜치 전환이 필요 없다(로컬 워킹트리를 건드리지 않는다).
# 성역(코드 수정 금지) 지정 레포라도 "이미 열려 있는 PR을 머지"하는 것은 코드 수정/편집 행위가 아니므로
# (PR 콘텐츠는 이미 사람 또는 이전 세션이 만들어 리뷰 가능한 상태로 올려둔 것) 대상에서 제외할 필요는
# 없다 — 제외하고 싶으면 호출부(-RepoPaths)에서 그 경로를 빼면 된다.
#
# 동작: 레포마다 열린 PR을 조회해 mergeable 값에 따라 분기한다.
#   - MERGEABLE   → squash 머지(+ 브랜치 삭제). -DryRun 이면 머지하지 않고 로그만 남긴다.
#   - CONFLICTING → 건드리지 않는다(별도의 PR 게이트 스윕(pr-gate-sweep.ps1)이 처리).
#   - UNKNOWN     → GitHub가 아직 계산 중. 이 실행에서는 재시도하지 않고 다음 :07에 재확인.
#   - 그 외 값    → 방어적으로 그대로 로그만 남기고 건너뛴다.
# 레포/PR 단위 실패가 전체 스윕을 절대 죽이지 않는다 — 무엇이 잘못되든 로그만 남기고 다음으로 넘어간다.
#
# [PowerShell 5.1 주의] -RepoPaths 는 이 스크립트를 `& script.ps1 -RepoPaths $array` 형태로 같은
# 프로세스 안에서 직접 호출해야 배열 전체가 바인딩된다. `powershell.exe -File script.ps1 -RepoPaths
# $array` 로 새 프로세스를 띄우면 배열의 첫 원소만 바인딩되고 나머지는 조용히 유실된다(실측 확인).

param(
    [string[]]$RepoPaths = @(),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir > $null }
$LogFile = Join-Path $LogDir 'gissue_merge_sweep.log'

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [merge-sweep] $msg"
    $line | Out-File -FilePath $LogFile -Append -Encoding UTF8
    Write-Output $line
}

foreach ($repoPath in $RepoPaths) {
    try {
        if (-not (Test-Path -LiteralPath $repoPath)) {
            Write-Log "SKIP: 경로 없음 ($repoPath)"
            continue
        }
        if (-not (Test-Path -LiteralPath (Join-Path $repoPath '.git'))) {
            Write-Log "SKIP: git 레포 아님 ($repoPath)"
            continue
        }

        Push-Location -LiteralPath $repoPath
        try {
            $prJson = $null
            try {
                $prJson = gh pr list --state open --json number,url,title,mergeable,mergeStateStatus 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "ERROR: gh pr list 실패 ($repoPath): $prJson"
                    continue
                }
            } catch {
                Write-Log "ERROR: gh pr list 예외 ($repoPath): $($_.Exception.Message)"
                continue
            }

            $prs = $null
            try {
                $prs = $prJson | ConvertFrom-Json
            } catch {
                Write-Log "ERROR: gh pr list 응답 파싱 실패 ($repoPath): $($_.Exception.Message)"
                continue
            }

            if (-not $prs -or @($prs).Count -eq 0) {
                Write-Log "OK: 열린 PR 없음 ($repoPath)"
                continue
            }

            foreach ($pr in @($prs)) {
                $num   = $pr.number
                $title = $pr.title
                $url   = $pr.url
                $mergeable = "$($pr.mergeable)"

                switch ($mergeable) {
                    'MERGEABLE' {
                        if ($DryRun) {
                            Write-Log "[DRY-RUN] would merge PR #$num $title ($url)"
                        } else {
                            try {
                                $mergeOut = gh pr merge $num --squash --delete-branch 2>&1
                                if ($LASTEXITCODE -eq 0) {
                                    Write-Log "[MERGED] PR #$num $title ($url)"
                                } else {
                                    Write-Log "[FAILED] PR #$num merge failed: $mergeOut"
                                }
                            } catch {
                                Write-Log "[FAILED] PR #$num merge failed: $($_.Exception.Message)"
                            }
                        }
                    }
                    'CONFLICTING' {
                        Write-Log "[SKIP-CONFLICT] PR #$num $title ($url) — conflicting, not touched (handled separately by PR gate sweep)"
                    }
                    'UNKNOWN' {
                        Write-Log "[SKIP-UNKNOWN] PR #$num $title ($url) — GitHub still computing mergeability, will recheck next hourly run"
                    }
                    default {
                        Write-Log "[SKIP-OTHER] PR #$num $title ($url) — mergeable=$mergeable"
                    }
                }
            }
        } finally {
            Pop-Location
        }
    } catch {
        Write-Log "[ERROR] repo $($repoPath): $($_.Exception.Message)"
    }
}
