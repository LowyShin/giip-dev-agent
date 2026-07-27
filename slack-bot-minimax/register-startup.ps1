# PM2 SlackBot 자동 시작 등록 스크립트
# 관리자 권한으로 실행 필요
# PC마다 사용자명·pm2 설치 경로가 다를 수 있어 현재 세션 기준으로 자동 탐지한다(하드코딩 금지).

$currentUser = "$env:USERDOMAIN\$env:USERNAME"

$pm2Cmd = Get-Command pm2.cmd -ErrorAction SilentlyContinue
if (-not $pm2Cmd) { $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue }
if (-not $pm2Cmd) {
    Write-Error "pm2 실행 파일을 찾을 수 없습니다. 'npm install -g pm2' 후 다시 실행하세요."
    exit 1
}
$pm2Path = $pm2Cmd.Source
$taskName = "PM2-SlackBot-Resurrect"

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$pm2Path`" resurrect"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable $true

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "PC 재기동 시 pm2 slack-bot 자동 시작" `
    -Force

Write-Host "✅ Task Scheduler 등록 완료: $taskName" -ForegroundColor Green
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
