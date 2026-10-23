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

## Diagnostics on the device cards

Cards only report what HQ actually observed or what the worker itself sent:
- no heartbeat for 30 s: "Le service worker ne r?pond plus depuis ?" (HQ cannot tell why; it is not reported as a Tailscale outage);
- a network/Tailscale problem is shown only when the worker reports it afterwards (`net: {code: "hq_unreachable", since, until}` in its poll, sent once HQ answers again; older workers simply omit it);
- Forge API down or busy, missing model/sampler/scheduler, refused credentials (bad signature), clock skew, unprotected secret, unknown hardware.
Each message gives the next step. The Add-device sheet walks through the six setup steps, copies only the non-secret pair/run commands and detects the new device live.

## Measured on the real Forge (read-only GETs, idle, 2026-10-22)

- `GET /sdapi/v1/loras` (sd_forge_lora): list of `{name, alias, metadata}`; no path, size or hash field.
  The optional content hash is `metadata.sshs_model_hash`. This PC had no LoRA (`[]`).
- `GET /sdapi/v1/memory` exists (200): `{ram:{free,used,total}, cuda:{system, active, allocated, reserved,
  inactive, events:{retries, oom}}}`. It is a weak signal and is **not** on the allowlist; HQ does not use it.
- Errors from `POST /sdapi/v1/txt2img` come from `modules/api/api.py` `handle_exception` as
  `{"error": <exception class name>, "detail", "body", "errors"}`. HQ and workers read only the class name;
  `OutOfMemoryError` is classified `forge_oom` ("Forge a manqué de mémoire GPU"). Read from the source;
  an actual out-of-memory failure was not provoked.

## Statistics (phase A)

`.hq-forge/stats.json` keeps up to 5000 records, one per image or failed attempt, from normal jobs and
multi-device batches only: checkpoint (+ sha256 for batches), sampler, scheduler, CFG, steps, size, hires,
seed, variation strength, device, duration, outcome, error code, attempt, uncertain. Never a prompt or a
negative prompt, never anything from the vault. Gallery images carry an optional `triage` flag
(`keep | reject | favorite`, absent = not sorted); rejected images are hidden in the bin, never deleted.


## Triage and Laboratoire (phase B)

- Gallery images carry a reversible flag (garder, rejeter, favori, non trie) in their meta.json; vault images carry it inside the encrypted index only (`POST /api/forge/vault/images/<id>/triage`, admin + CSRF + vault session). Rejected means "in the bin": nothing is deleted.
- `GET /api/forge/lab` (admin, read-only) summarises `.hq-forge/stats.json` in three separate views: speed, reliability, keep rate. No single score. A setting needs 20 measurements before it is compared; only runs with the same checkpoint, size and hires are compared; settings only ever measured together are listed as confounded. Vault data never reaches the stats file, so it is excluded by construction.
- "Appliquer ces reglages" only fills technical form fields (checkpoint, sampler, scheduler, size, steps, CFG), says what changed and what this HQ lacks, and never starts a job or touches the prompt.