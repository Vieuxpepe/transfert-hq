# One-shot: prepare dataset, build character sheet, train LoRA (needs Kohya sd-scripts + SDXL checkpoint path).
$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $Root

python tools/companion_lora/prepare_dataset.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

python tools/companion_lora/build_character_sheet.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Kohya = $env:KOHYA_SD_SCRIPTS
if (-not $Kohya) { $Kohya = "C:\AI\sd-scripts" }
if (-not (Test-Path "$Kohya\train_network.py")) {
    Write-Host @"

Kohya sd-scripts not found at: $Kohya

Install once:
  git clone https://github.com/kohya-ss/sd-scripts $Kohya
  cd $Kohya
  python -m venv venv
  .\venv\Scripts\activate
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
  pip install -r requirements.txt
  pip install xformers

Edit tools/companion_lora/train_transferania.toml — set pretrained_model_name_or_path to your SDXL checkpoint file.

Then re-run:  .\tools\companion_lora\train_transferania.ps1

"@ -ForegroundColor Yellow
    exit 2
}

$Toml = Join-Path $PSScriptRoot "train_transferania.toml"
$Py = Join-Path $Kohya "venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { $Py = "python" }

Write-Host "Starting SDXL LoRA training (expect 30–90 min on RTX 4060)..." -ForegroundColor Cyan
$Accel = Join-Path $Kohya "venv\Scripts\accelerate.exe"
if (-not (Test-Path $Accel)) { $Accel = "accelerate" }
& $Accel launch --num_cpu_threads_per_process 1 (Join-Path $Kohya "sdxl_train_network.py") --config_file $Toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$OutDir = Join-Path $Root ".hq-ai\companion_lora_output"
$DestLora = "C:\AI\stable-diffusion-webui-forge\models\Lora\transferania_char.safetensors"
$Latest = Get-ChildItem $OutDir -Filter "transferania_char*.safetensors" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($Latest) {
    Copy-Item $Latest.FullName $DestLora -Force
    Write-Host "Copied LoRA to Forge: $DestLora" -ForegroundColor Green
    Write-Host 'Set in .hq-ai/companion_forge.json: "character_lora_name": "transferania_char", "character_lora_weight": 0.82'
}
