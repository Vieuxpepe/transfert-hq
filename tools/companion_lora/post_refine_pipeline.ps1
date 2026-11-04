# After refine train: copy newest checkpoint, start Forge, render weight sweep
$ErrorActionPreference = "Stop"
$Root = "C:\Transfert"
$Out = Join-Path $Root ".hq-ai\companion_lora_output"
$ForgeLora = "C:\AI\stable-diffusion-webui-forge\models\Lora\transferania_char.safetensors"
$Meta = Join-Path $Root ".hq-ai\companion_forge.json"
$Log = Join-Path $Out "train_refine.log"

$deadline = (Get-Date).AddHours(3)
while ((Get-Date) -lt $deadline) {
    $proc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "sdxl_train_network" }
    $files = Get-ChildItem -Path $Out -Filter "transferania_char-*.safetensors" -ErrorAction SilentlyContinue
    if (-not $proc -and $files) { break }
    Start-Sleep -Seconds 60
}

$latest = Get-ChildItem -Path $Out -Filter "transferania_char-*.safetensors" | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) {
    Write-Host "No LoRA checkpoint found." -ForegroundColor Red
    exit 1
}
Copy-Item $latest.FullName $ForgeLora -Force
Write-Host "Installed $($latest.Name) -> $ForgeLora" -ForegroundColor Green

Set-Location "C:\AI\stable-diffusion-webui-forge"
$forgeProc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "launch.py" }
if (-not $forgeProc) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c webui-user.bat" -WorkingDirectory "C:\AI\stable-diffusion-webui-forge" -WindowStyle Minimized
    $t0 = Get-Date
    while ((Get-Date) -lt $t0.AddMinutes(8)) {
        if ((Test-NetConnection 127.0.0.1 -Port 7860 -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
        Start-Sleep -Seconds 15
    }
}

Set-Location $Root
python tools/companion_lora/generate_weight_samples.py 0.52 0.62 0.72
Write-Host "Samples in assets/companion/transferania-lora-w*.jpg" -ForegroundColor Cyan
