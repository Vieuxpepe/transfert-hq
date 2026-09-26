# Install / refresh Transfert Bridge logon autostart
$ErrorActionPreference = 'Stop'
$taskName = 'TransfertBridge'
$bridge = 'D:\Transfert\iphone_bridge.py'
$vbs = 'D:\Transfert\start_bridge_hidden.vbs'
$py = (Get-Command py -ErrorAction Stop).Source

$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "$py" & chr(34) & " -3 " & chr(34) & "$bridge" & chr(34), 0, False
"@
Set-Content -Path $vbs -Value $vbsContent -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task '$taskName' installed for $env:USERNAME"
Write-Host "VBS launcher: $vbs"
