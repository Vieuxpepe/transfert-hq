# Prefer Enable-OpenSSH-Server.bat + Authorize-HQ-SSH-Key.bat for new remotes.
# This script installs the HQ pubkey and applies Tailscale CGNAT firewall +
# PasswordAuthentication no (aligned with Enable-OpenSSH-Server.bat).

# Transfert HQ - install HQ SSH pubkey on THIS PC (Administrator)
# Writes log to Desktop\transfert-ssh-fix.log

$ErrorActionPreference = "Continue"
$log = Join-Path ([Environment]::GetFolderPath("Desktop")) "transfert-ssh-fix.log"

function Log {
  param([string]$Msg, [string]$Color = "White")
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line -ForegroundColor $Color
}

try { Clear-Content -Path $log -ErrorAction SilentlyContinue } catch {}

Log "=== Transfert SSH key fix START ===" "Cyan"
Log ("Computer: " + $env:COMPUTERNAME)
Log ("User: " + $env:USERNAME)
Log ("Whoami: " + (whoami))

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Log "NOT admin - relaunching elevated..." "Yellow"
  $self = $MyInvocation.MyCommand.Path
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $self
  )
  exit
}

$pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINhXW/0HIg+PvFqn4hp8P4dZIT6ONOPilTh1W7CyhGG8 transfert-hq@VIEUXPEEPEE"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$beside = Join-Path $scriptDir "hq_ssh.pub"
if (Test-Path $beside) {
  $fromFile = Get-Content $beside -ErrorAction SilentlyContinue | Where-Object { $_ -match "^ssh-" } | Select-Object -First 1
  if ($fromFile) {
    $pub = $fromFile.Trim()
    Log "Using hq_ssh.pub beside script" "Green"
  }
}
$preview = $pub.Substring(0, [Math]::Min(70, $pub.Length))
Log ("Pubkey: " + $preview + "...")

try {
  $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like "OpenSSH.Server*" } | Select-Object -First 1
  if ($null -ne $cap -and $cap.State -ne "Installed") {
    Log ("Installing OpenSSH Server " + $cap.Name + "...") "Yellow"
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    Log "OpenSSH Server installed" "Green"
  } elseif ($null -ne $cap) {
    Log "OpenSSH Server already installed" "Green"
  } else {
    Log "OpenSSH.Server capability not found" "Red"
  }
} catch {
  Log ("OpenSSH install warning: " + $_.Exception.Message) "Yellow"
}

try {
  Start-Service sshd -ErrorAction Stop
  Set-Service sshd -StartupType Automatic
  Log ("sshd status: " + (Get-Service sshd).Status) "Green"
} catch {
  Log ("sshd start FAILED: " + $_.Exception.Message) "Red"
}

$userDir = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
$userAuth = Join-Path $userDir "authorized_keys"
$lines = @()
if (Test-Path $userAuth) {
  $lines = @(Get-Content $userAuth | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
if ($lines -notcontains $pub) {
  $lines += $pub
  Set-Content -Path $userAuth -Value ($lines -join "`n") -Encoding ascii
  Log ("Added key to " + $userAuth) "Green"
} else {
  Log ("Key already in " + $userAuth) "Green"
}
& icacls $userAuth /inheritance:r | Out-Null
& icacls $userAuth /grant:r ($env:USERNAME + ":(R)") | Out-Null
& icacls $userAuth /grant:r "SYSTEM:(F)" | Out-Null

$prog = Join-Path $env:PROGRAMDATA "ssh"
New-Item -ItemType Directory -Force -Path $prog | Out-Null
$adminAuth = Join-Path $prog "administrators_authorized_keys"
$alines = @()
if (Test-Path $adminAuth) {
  $alines = @(Get-Content $adminAuth | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
if ($alines -notcontains $pub) {
  $alines += $pub
  Set-Content -Path $adminAuth -Value ($alines -join "`n") -Encoding ascii
  Log ("Added key to " + $adminAuth) "Green"
} else {
  Log ("Key already in " + $adminAuth) "Green"
}
& icacls $adminAuth /inheritance:r | Out-Null
& icacls $adminAuth /grant "SYSTEM:(F)" | Out-Null
& icacls $adminAuth /grant "Administrators:(F)" | Out-Null
Log "ACL fixed on administrators_authorized_keys" "Green"


# Align with Enable-OpenSSH-Server.bat: Tailscale CGNAT firewall + no password auth
try {
  $fwName = "OpenSSH-Server-In-TCP"
  $rule = Get-NetFirewallRule -Name $fwName -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -Name $fwName -DisplayName "OpenSSH SSH Server (Tailscale only)" `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 `
      -RemoteAddress 100.64.0.0/10 | Out-Null
    Log "Firewall rule created (Tailscale CGNAT 100.64.0.0/10)" "Green"
  } else {
    Set-NetFirewallRule -Name $fwName -Enabled True -Action Allow -ErrorAction SilentlyContinue
    Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule | Set-NetFirewallAddressFilter -RemoteAddress 100.64.0.0/10
    Log "Firewall rule scoped to 100.64.0.0/10" "Green"
  }
} catch {
  Log ("Firewall warn: " + $_.Exception.Message) "Yellow"
}

$cfg = Join-Path $prog "sshd_config"
if (Test-Path $cfg) {
  $lines = Get-Content -LiteralPath $cfg
  $lines = $lines | Where-Object { $_ -notmatch "^\s*PasswordAuthentication\s+" }
  $lines = @($lines) + @("PasswordAuthentication no")
  if (-not ($lines | Where-Object { $_ -match "^\s*PubkeyAuthentication\s+" })) {
    $lines = @($lines) + @("PubkeyAuthentication yes")
  }
  Set-Content -LiteralPath $cfg -Value $lines -Encoding ascii
  Log "sshd: PasswordAuthentication no / PubkeyAuthentication yes" "Green"
}


try {
  Restart-Service sshd -Force
  Log "sshd restarted" "Green"
} catch {
  Log ("sshd restart warning: " + $_.Exception.Message) "Yellow"
}

$ts = $null
try {
  $ts = & "C:\Program Files\Tailscale\tailscale.exe" ip -4 2>$null
} catch {}
if ($ts) {
  Log ("Tailscale IP: " + $ts) "Cyan"
} else {
  Log "Tailscale IP: (none)" "Cyan"
}
Log "=== DONE ===" "Cyan"
Log ("Log saved to: " + $log) "Cyan"
Write-Host ""
Write-Host "Window stays open. Log on Desktop: transfert-ssh-fix.log" -ForegroundColor Yellow
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
