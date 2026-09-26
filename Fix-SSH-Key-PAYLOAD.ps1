# Prefer Enable-OpenSSH-Server.bat + Authorize-HQ-SSH-Key.bat for new remotes.
# This script still installs the HQ key and applies Tailscale/sshd hardening.
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

# Align with Enable-OpenSSH-Server.bat: Tailscale CGNAT firewall + no password auth
try {
  $name='OpenSSH-Server-In-TCP'
  $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -Name $name -DisplayName 'OpenSSH SSH Server (Tailscale only)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 `
      -RemoteAddress 100.64.0.0/10 | Out-Null
    L 'Firewall rule created (Tailscale CGNAT 100.64.0.0/10)'
  } else {
    Set-NetFirewallRule -Name $name -Enabled True -Action Allow -ErrorAction SilentlyContinue
    Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule | Set-NetFirewallAddressFilter -RemoteAddress 100.64.0.0/10
    L 'Firewall rule scoped to 100.64.0.0/10'
  }
} catch { L ('Firewall warn: '+$_.Exception.Message) }
if (Test-Path $cfg) {
  $c = Get-Content -LiteralPath $cfg
  $c = $c | Where-Object { $_ -notmatch '^\s*PasswordAuthentication\s+' }
  $c += 'PasswordAuthentication no'
  if (-not ($c | Where-Object { $_ -match '^\s*PubkeyAuthentication\s+' })) { $c += 'PubkeyAuthentication yes' }
  Set-Content -LiteralPath $cfg -Value $c -Encoding ascii
  L 'sshd: PasswordAuthentication no / PubkeyAuthentication yes'
}

try { Restart-Service sshd -Force; L 'sshd restarted' } catch { L ('restart warn: '+$_.Exception.Message) }
L '=== DONE ==='
L 'Prefer Enable-OpenSSH-Server.bat for full first-time OpenSSH hardening on remote PCs.'
