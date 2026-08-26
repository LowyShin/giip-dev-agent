<#
register-hourly-issue-scheduler.ps1

giip issue 상태머신을 매시 :07(cron: `7 * * * *`)에 무인 처리하는 Windows 스케줄러를 등록/해제/확인한다.
표준 스펙 정본: docs/60-operations/hourly-issue-scheduler.md (이 스크립트는 그 §2~§3 을 구현).

이 스크립트는 giip-fde-agent 안에서 그 자체로 완결된다(외부 lowyworkenv 경로에 의존하지 않는다).
다른 PC/배포 대상은 -RepoRoot 에 자기 오케스트레이션 레포 루트만 넘기면 그대로 등록할 수 있다.

사용 예:
  # 기본값(매시 :07, 00:07:00 시작)으로 등록
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\register-hourly-issue-scheduler.ps1 `
    -Action Register -RepoRoot "C:\path\to\your-orchestration-repo"

  # 등록 상태 확인
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\register-hourly-issue-scheduler.ps1 -Action Status

  # 등록 해제
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\register-hourly-issue-scheduler.ps1 -Action Unregister
#>
param(
    [ValidateSet('Register', 'Unregister', 'Status')]
    [string]$Action = 'Status',

    # 오케스트레이션 레포 루트(예: lowyworkenv 또는 그 대응물). RunnerRelativePath 기준의 부모 경로.
    [string]$RepoRoot = '',

    # $RepoRoot 기준 상대경로. 원본 배포는 scripts/gissue/run-gissue-claude.ps1 을 그대로 씀.
    [string]$RunnerRelativePath = 'scripts/gissue/run-gissue-claude.ps1',

    # Windows 작업 스케줄러에 등록할 태스크 이름. 배포 대상마다 고유해야 한다(원본: GIIP_Gissue_Claude).
    [string]$TaskName = 'GIIP_Gissue_Claude',

    # 최초 트리거 시작 시각(HH:mm:ss). 기본 00:07:00 = 매시 :07 반복의 기준점.
    [string]$StartTime = '00:07:00',

    # 반복 주기(분). 기본 60분 = 매시 1회.
    [int]$RepetitionMinutes = 60,

    # 이 태스크를 실행할 계정. 기본값은 현재 로그온 사용자(대화식 로그온 여부와 무관하게 동작하도록
    # -RunLevel Limited, "로그온 여부와 관계없이 실행" 대신 로그온 시 실행 트리거를 쓰지 않고 시간
    # 기반 트리거만 쓰므로 이 계정이 세션에 로그인돼 있을 필요는 없다 — 단, 저장된 자격 증명이 필요하면
    # 최초 등록 시 비밀번호 입력이 프롬프트로 뜰 수 있다. 무인 등록을 원하면 -Password 를 넘긴다).
    [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME",

    # RunAsUser 의 비밀번호(선택). 넘기면 로그온 여부와 무관하게 실행되도록(S4U 대신 password 인증으로)
    # 등록한다. 넘기지 않으면 Register-ScheduledTask 가 대화형 자격증명 프롬프트를 띄울 수 있다.
    [securestring]$Password
)

$ErrorActionPreference = 'Stop'

function Resolve-RunnerPath {
    if (-not $RepoRoot) {
        throw "-RepoRoot 이 필요합니다(오케스트레이션 레포 루트, 예: C:\path\to\lowyworkenv). -Action Status/Unregister 는 -RepoRoot 없이도 가능합니다."
    }
    $root = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
    $runner = Join-Path $root $RunnerRelativePath
    if (-not (Test-Path -LiteralPath $runner)) {
        throw "러너 스크립트를 찾을 수 없습니다: $runner (RepoRoot=$RepoRoot, RunnerRelativePath=$RunnerRelativePath 확인)"
    }
    return $runner
}

function Show-Status {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
        [pscustomobject]@{
            TaskName       = $TaskName
            State          = $task.State
            Enabled        = ($task.Settings.Enabled -ne $false)
            Action         = ($task.Actions | Select-Object -First 1 | ForEach-Object { "$($_.Execute) $($_.Arguments)" })
            LastRunTime    = $info.LastRunTime
            LastTaskResult = $info.LastTaskResult
            NextRunTime    = $info.NextRunTime
        } | Format-List
    } catch {
        Write-Output "태스크 없음: $TaskName"
    }
}

function Register-HourlyTask {
    $runner = Resolve-RunnerPath
    $execArgs = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $execArgs

    # 주의: [TimeSpan]::MaxValue 는 "무기한 반복" 의도로 쓰였으나, ISO8601 duration으로 직렬화하면
    # P99999999DT23H59M59S 가 되어 Task Scheduler XML 스키마의 duration 상한을 초과한다. 그 결과
    # Register-ScheduledTask 가 "태스크 XML에 부적절한 설정이 있거나 범위 외의 값이 포함되어 있습니다"
    # (HRESULT 0x80041318)로 등록 자체를 거부한다(giip #1275, 실측). 대신 유효 범위 내에서 충분히 큰
    # 값(약 10년)을 써서 사실상 무기한 반복을 구현한다.
    $trigger = New-ScheduledTaskTrigger -Once -At $StartTime `
        -RepetitionInterval (New-TimeSpan -Minutes $RepetitionMinutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    # 주의(giip #1562, 2026-08-26 실측): MultipleInstances=IgnoreNew였을 때, 느린 CSN(예: csn 47) 하나
    # 때문에 한 인스턴스가 ExecutionTimeLimit(2시간)까지 살아있는 동안 다음 정기 트리거(들)가 "이전
    # 인스턴스 실행 중"이라는 이유로 통째로 스킵됐다(이벤트 ID 322) — 그 결과 csn 47과 무관한 다른 모든
    # CSN(2, 33, 70335, 70374 등)의 처리까지 몇 시간씩 동반 정지됐다. 각 CSN은 이미 자체 파일 락
    # (run-gissue-claude.ps1의 logs\gissue_csn<N>.lock, 2시간 초과 시 stale 자동제거)으로 "같은 CSN을
    # 여러 인스턴스가 동시 처리"하는 것을 막고 있으므로, 그 전제 하에 Parallel로 전환해 새 트리거가
    # 통째로 스킵되지 않고(느린 CSN과 무관한 다른 CSN은) 정상 진행되도록 한다.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances Parallel `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2)

    $registerArgs = @{
        TaskName    = $TaskName
        Action      = $action
        Trigger     = $trigger
        Settings    = $settings
        Description = "giip issue 상태머신 매시 :07 무인 처리 (표준 스펙: docs/60-operations/hourly-issue-scheduler.md, runner=$runner)"
        Force       = $true
    }

    if ($Password) {
        $cred = New-Object System.Management.Automation.PSCredential($RunAsUser, $Password)
        $registerArgs['User']     = $cred.UserName
        $registerArgs['Password'] = $cred.GetNetworkCredential().Password
        $registerArgs['RunLevel'] = 'Limited'
    } else {
        $registerArgs['User']     = $RunAsUser
        $registerArgs['RunLevel'] = 'Limited'
    }

    Register-ScheduledTask @registerArgs | Out-Null
    Write-Output "등록 완료: $TaskName (시작 $StartTime, ${RepetitionMinutes}분마다 반복, runner=$runner)"
    Show-Status
}

function Unregister-HourlyTask {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Output "등록 해제 완료: $TaskName"
    } catch {
        Write-Output "태스크가 이미 없거나 해제 실패: $TaskName ($($_.Exception.Message))"
    }
}

switch ($Action) {
    'Register'   { Register-HourlyTask }
    'Unregister' { Unregister-HourlyTask }
    'Status'     { Show-Status }
}
