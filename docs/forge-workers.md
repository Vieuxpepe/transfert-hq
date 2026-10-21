# Forge generation workers (multi-device)

A worker is another Windows PC that generates images for Transfert HQ with
its own Stable Diffusion WebUI Forge. HQ coordinates; the worker only polls
HQ outbound over Tailscale. HQ never connects to the worker, and the browser
never talks to a worker.

## Prerequisites on the worker PC

- Tailscale signed in to the same tailnet as HQ (HQ is reached at its
  `https://<name>.<tailnet>.ts.net` Serve address).
- Forge started with `--api` and without `--listen`, so it binds
  127.0.0.1 only (port 7860 by default; pass another port to the worker
  with `--forge-port`).
- The checkpoints, samplers and upscalers you plan to use. HQ refuses a batch
  when a selected device lacks the chosen model; it never substitutes one.
- Python 3.10+ (standard library only, no packages to install).

## Install and pair

1. Copy `hq_forge_worker.py` from the HQ repository to a folder on the
   worker, for example `C:\TransfertWorker\`.
2. In Forge Studio, open **Appareils de génération → Ajouter un appareil**
   and press **Créer un code à usage unique**. The code is valid for
   10 minutes, once, and is shown only there.
3. In PowerShell on the worker:

   ```powershell
   cd C:\TransfertWorker
   py -3 .\hq_forge_worker.py pair --hq https://<hq>.<tailnet>.ts.net --name "PC salon"
   ```

   Paste the code when asked. It is read from stdin (hidden), never from the
   command line. `--code-file <path>` reads it from a file you protect
   yourself instead.
4. The worker id and secret are written to
   `%LOCALAPPDATA%\TransfertHQ\forge-worker.json` with a protected DACL
   (SYSTEM, Administrators, the current user; inheritance removed).

## Run

```powershell
py -3 .\hq_forge_worker.py run              # Forge on 127.0.0.1:7860
py -3 .\hq_forge_worker.py run --forge-port 7861
```

The device appears in Forge Studio with its GPU, VRAM (from `nvidia-smi`
only; unknown otherwise), CPU, RAM, loaded model and Forge state.

### Start at logon (suggested)

Create a scheduled task for the worker's own user account, run only when the
user is logged on (Forge itself needs the interactive session):

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Windows\pyw.exe" -Argument '-3 "C:\TransfertWorker\hq_forge_worker.py" run' -WorkingDirectory "C:\TransfertWorker"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "TransfertForgeWorker" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
```

## Manage and revoke

In the device card (**Caractéristiques**): rename, **Désactiver** (stops new
tasks; the device still reports health), **Retirer** (revokes the secret; a
new pairing code is needed to add it back). Delete the worker's credential
file after a removal.

## Behaviour worth knowing

- Every worker request is signed: HMAC-SHA256 over
  `hq-forge-worker-v1|METHOD|path|timestamp|nonce|sha256(body)`, ±90 s skew,
  nonces remembered for 180 s (in memory: after an HQ restart a captured
  request could be replayed inside that window; TLS from Tailscale Serve
  protects ordinary traffic).
- HQ keeps the worker secret wrapped with Windows DPAPI (HQ's user account) in
  `.hq-forge\workers.json`; enrollment codes are stored as hashes only.
- Protection fails closed: if DPAPI is unavailable or fails, pairing is refused
  (HTTP 503) with no worker record and nothing written; the pairing code is NOT
  consumed, so it can be retried until it expires. There is no plaintext fallback.
- A record whose secret is not DPAPI-wrapped (e.g. a legacy plaintext one) is never
  used or converted: the worker is refused and its card says "Secret non protégé —
  réassocier l'appareil". Remove the device and pair it again.
- One task is one image. Fixed seed `s` gives `s, s+1, …` (mod 2^32); a random
  seed draws one per image, recorded in the batch and the gallery metadata.
- If a worker stops answering after it received a task, the task becomes
  *incertaine* and is not re-run, so no image is generated twice. Tasks that
  were never sent wait for any selected device.
- Cancel drops waiting tasks. A task already sent finishes; Forge's global
  `/interrupt` is never called.
- Private (vault) generation stays on the HQ machine. Private prompts are never
  sent to workers.
- Images are checked (PNG signature, size, dimensions) and stored in the normal
  HQ gallery with worker and batch provenance. The gallery quota applies; a
  full gallery fails the remaining images without deleting anything.
