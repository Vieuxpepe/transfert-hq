$ErrorActionPreference='Continue'
$log='C:\Temp\transfert-ssh-fix\log.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function L($m){ $t='[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'),$m; Add-Content $log $t; Write-Host $t }
L ('Computer=' + $env:COMPUTERNAME + ' User=' + $env:USERNAME + ' Whoami=' + (whoami))
$pub='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINhXW/0HIg+PvFqn4hp8P4dZIT6ONOPilTh1W7CyhGG8 transfert-hq@VIEUXPEEPEE'
try {
  $cap=Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
  if ($cap -and $cap.State -ne 'Installed') { L 'Installing OpenSSH...'; Add-WindowsCapability -Online -Name $cap.Name | Out-Null; L 'OpenSSH installed' }
  else { L 'OpenSSH present' }
} catch { L ('OpenSSH warn: '+$_.Exception.Message) }
try { Start-Service sshd; Set-Service sshd -StartupType Automatic; L ('sshd='+(Get-Service sshd).Status) } catch { L ('sshd FAIL: '+$_.Exception.Message) }
$ud=Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $ud | Out-Null
$ua=Join-Path $ud 'authorized_keys'
$lines=@(); if (Test-Path $ua) { $lines=@(Get-Content $ua | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
if ($lines -notcontains $pub) { $lines+=$pub; Set-Content $ua ($lines -join [char]10) -Encoding ascii; L 'added user authorized_keys' } else { L 'user key exists' }
icacls $ua /inheritance:r | Out-Null
icacls $ua /grant:r ($env:USERNAME+':(R)') | Out-Null
icacls $ua /grant:r 'SYSTEM:(F)' | Out-Null
$prog=Join-Path $env:PROGRAMDATA 'ssh'; New-Item -ItemType Directory -Force -Path $prog | Out-Null
$aa=Join-Path $prog 'administrators_authorized_keys'
$al=@(); if (Test-Path $aa) { $al=@(Get-Content $aa | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
if ($al -notcontains $pub) { $al+=$pub; Set-Content $aa ($al -join [char]10) -Encoding ascii; L 'added administrators_authorized_keys' } else { L 'admin key exists' }
icacls $aa /inheritance:r | Out-Null
icacls $aa /grant 'SYSTEM:(F)' | Out-Null
icacls $aa /grant 'Administrators:(F)' | Out-Null
$cfg=Join-Path $prog 'sshd_config'
if (Test-Path $cfg) {
  $c=Get-Content $cfg -Raw
  if ($c -notmatch '(?m)^PubkeyAuthentication\s+yes') {
    Add-Content $cfg ([Environment]::NewLine + 'PubkeyAuthentication yes')
    L 'PubkeyAuthentication enabled'
  }
}
try { Restart-Service sshd -Force; L 'sshd restarted' } catch { L ('restart warn: '+$_.Exception.Message) }
L '=== DONE ==='
