# Waits for training output, copies LoRA into Forge, updates companion_forge.json
$ErrorActionPreference = "Stop"
$Root = "C:\Transfert"
$OutDir = Join-Path $Root ".hq-ai\companion_lora_output"
$ForgeLora = "C:\AI\stable-diffusion-webui-forge\models\Lora\transferania_char.safetensors"
$Meta = Join-Path $Root ".hq-ai\companion_forge.json"
$Log = Join-Path $OutDir "train.log"

Write-Host "Waiting for transferania_char*.safetensors in $OutDir ..."
$deadline = (Get-Date).AddHours(2)
while ((Get-Date) -lt $deadline) {
    $files = Get-ChildItem -Path $OutDir -Filter "transferania_char*.safetensors" -ErrorAction SilentlyContinue
    if ($files) {
        $latest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        New-Item -ItemType Directory -Force -Path (Split-Path $ForgeLora) | Out-Null
        Copy-Item $latest.FullName $ForgeLora -Force
        Write-Host "Installed: $ForgeLora (from $($latest.Name))" -ForegroundColor Green
        $json = Get-Content $Meta -Raw | ConvertFrom-Json
        $json | Add-Member -NotePropertyName character_lora_name -NotePropertyValue transferania_char -Force
        $json | Add-Member -NotePropertyName character_lora_weight -NotePropertyValue 0.82 -Force
        if ($json.PSObject.Properties.Name -contains "character_seed") { $json.PSObject.Properties.Remove("character_seed") }
        $json | ConvertTo-Json -Depth 6 | Set-Content $Meta -Encoding utf8
        Write-Host "Updated $Meta" -ForegroundColor Green
        exit 0
    }
    Start-Sleep -Seconds 45
}
Write-Host "Timed out — check $Log" -ForegroundColor Red
exit 1
