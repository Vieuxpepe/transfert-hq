# Forge generation workers (multi-device)

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


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
## Planner (phase C)

- `GET /api/forge/lab?plan=1&width=&height=&steps=&hires=&count=&checkpoint=` (same read-only admin route, no new route) returns, per device, a duration range (20th-80th percentile per image x count) from completed measurements with the same size, steps and hires. Under 5 measurements a device reads "Pas assez de donnees". With two or more measured devices it suggests a split proportional to measured speed; it is shown as indicative and never changes how HQ splits a batch.
- Measurements are narrowed to the selected checkpoint when it has any; otherwise all checkpoints of that size are used (known limitation).
- Memory warnings come only from recorded `forge_oom` failures for the same size and hires (local jobs: same or smaller image count; batch tasks: any). `/sdapi/v1/memory` is not used: it is not allowlisted.

## Journal and uncertain work (phase D)

- Batches and local jobs show a collapsed Journal: one line per image (device, sent, finished, duration, attempt, resolution). Local jobs expose `started_at`, `finished_at`, `duration_ms` and `resolution` (times only, never a prompt).
- Uncertain work gets an explicit choice, never an automatic relaunch: Relancer (batch: `POST /api/forge/batches/<id>/retry` with `{tasks:[id]}` for that image only; local job: settings are put back in the form and nothing starts), Marquer perdue / Garder tel quel (`POST /api/forge/batches/<id>/tasks/<task>/resolve` and `POST /api/forge/jobs/<id>/resolve`, `{action: lost|keep}`, admin + CSRF). A resolved image is no longer offered for retry; a late upload from the first device is still accepted.

## Bridge: refused POSTs (phase D4)

A POST refused before its body is read (CSRF 403, anonymous 401, upload-role 403) now reads and discards a declared body of up to 64 KB, for at most 1.5 s, before it answers. Larger, missing or invalid lengths are not read and the reply carries `Connection: close`. So each refused unauthenticated POST can cost the bridge up to 1.5 s and 64 KB of reading. That is acceptable for a single-owner bridge reachable only over Tailscale. If the bridge is ever exposed more widely, a per-IP limit on these refusals is required first.

## Wake-on-LAN (phase F1)

- Wake only. There is no power-off, sleep or restart action, by design.
- The magic packet (UDP broadcast to 255.255.255.255:9) is sent **by the coordinator HQ, on its own local network**. It does not cross Tailscale or any routed VPN: the worker PC must sit on the same LAN/broadcast domain as the HQ.
- The worker PC must support it: "Wake on LAN" / "Power on by PCI-E" enabled in the BIOS/UEFI, and "Wake on Magic Packet" enabled on the network card (Windows: Device Manager > adapter > Power Management / Advanced). Fast Startup and Wi-Fi adapters often prevent it; a wired NIC is the reliable case.
- The MAC address is stored as device config in the fleet registry. It never travels in a URL, is never written to logs and is never echoed back: the UI only shows its last five characters. An empty value forgets it.
- Routes (admin session + CSRF, same as rename/disable/remove; 401 anonymous, 403 non-admin or cross-site, 404 unknown device or the local HQ):
  - `POST /api/forge/devices/<id>/wake-config` with `{"mac": "AA-BB-CC-DD-EE-FF"}` (or `""` to clear); 400 on an invalid MAC.
  - `POST /api/forge/devices/<id>/wake`; 409 when no MAC is set or the device is already online, 429 within 10 s of the previous packet, 503 when the packet cannot be sent.
- A 200 only means the packet left the HQ; the device shows "En ligne" once its worker starts and checks in.
- Verified with a mocked sender only; a real LAN wake has not been tested.

## LoRA exclusion messages (phase F2)

When a prompt names a LoRA, a PC is left out of the batch with one of four distinct reasons:

- **absent**: "<PC> n'a pas le LoRA ? x ?, exclu." (the full list was read and x is not in it);
- **unreadable**: "liste des LoRA illisible" (Forge did not answer /sdapi/v1/loras, or answered something that is not a list);
- **too large**: "liste des LoRA trop grande (> 1 Mo), non lue" (the reply went over the 1 MiB probe cap; the worker never parses it and sends `{"error": "too_large"}`; the local HQ flags the same case);
- **past the limit**: "LoRA ? x ? non v?rifiable : au-del? de la limite de 96 LoRA lus" (only the first 96 entries are kept; x may exist further down).

When the reference device itself is in the unreadable or too-large case, the others say "LoRA non comparables : sur l'appareil de r?f?rence, ...". Verified with mocks only.

## Night workshop (phase G)

- Queue normal-mode generations on this HQ's Forge: "Lancer ce soir" (22:00-07:00, local time) or "Quand Forge est libre". "Finir les gard?es cette nuit" queues one finish (hires ?2, denoise 0.4) per kept or favourite gallery image, one at a time.
- Private generations are never queued: the panel is disabled in private mode and says why, and the server refuses any entry marked private (403) without storing it.
- Each entry becomes an ordinary HQ job via the single-job path, so the existing idle detection decides: Forge busy for its owner, an HQ job, or a fleet task on the local GPU -> the entry waits. Nothing is interrupted or skipped; cancelling affects only entries not yet sent.
- Guard rails: 24 entries at most; a 6 h budget per night from the first start (the rest expire); "tonight" entries not reached by 07:00 expire.
- One quiet morning summary card (counts and thumbnails) shown until "Vu"; no notification, no sound.
- Stored in `.hq-forge/night.json` (normal-mode settings only).
- Routes (admin session + CSRF; 401 anonymous, 403 non-admin or cross-site, 404 unknown entry/route): `GET /api/forge/night`, `POST /api/forge/night`, `POST /api/forge/night/finish-kept`, `POST /api/forge/night/<id>/cancel`, `POST /api/forge/night/cancel-all`, `POST /api/forge/night/ack`.
- Verified with a mock Forge only.

## Searchable vault (phase H)

- Tags (12 at most, 32 characters each) and one collection per vault image are stored in the vault's encrypted index (`index.bin`, AES-GCM with the vault key), like the sort flag. They are never written in clear, and backups carry them encrypted.
- Prompt search: on the first search after an unlock, HQ decrypts the vault objects in memory and keeps a folded (case- and accent-insensitive) copy of the prompts on that unlock session only. Locking, the 5-minute auto-lock, logout, a passphrase change, a restore or any vault write drops it. It is never written to disk, logs, history, statistics or workers.
- Searches are POST bodies, so the words never appear in a URL or an access log; the page keeps results in memory only and wipes the search field, chips and results when the vault locks. Nothing goes to browser storage.
- The bin (rejected images) is not searched. A damaged object is skipped; a damaged index refuses with the usual "coffre illisible" error.
- Routes (admin session + CSRF + unlocked vault; 401 anonymous or locked, 403 non-admin or cross-site, 404 unknown image): `POST /api/forge/vault/search` `{q, tag, collection}`, `POST /api/forge/vault/images/<id>/labels` `{tags, collection}`.
- Verified with a temporary vault and synthetic images only.

## Phase I: retoucher une zone (finger inpainting)

- Route set change, approved by Emie: HQ `ALLOWED_ROUTES` (hq_forge.py) is exactly the previous set plus `POST /sdapi/v1/img2img`, for this PC's Forge only. Worker `FORGE_ROUTES` is unchanged: inpainting never goes to a worker. Body cap 24 MiB for img2img (txt2img stays 256 KiB); the HQ route `POST /api/forge/inpaint` accepts at most 3 MiB.
- New HQ routes (admin + CSRF): `POST /api/forge/inpaint`, `GET /api/forge/inpaint`, `GET /api/forge/inpaint/<id>`. No cancel: Forge is never interrupted or skipped, options and models are never switched: the img2img body has no `override_settings`, so the retouch runs on the model Forge has loaded (read from the status probe, named in the dialog, recorded in the result's settings; refused with `no_model` if it is not in the catalog). The body is built from the fixed `BODY_KEYS` whitelist in `hq_forge_inpaint.py`, with no script fields, and always sets `do_not_save_samples` and `do_not_save_grid`.
- GPU sharing: a retouch is refused (409) while an HQ job, a fleet task on this GPU, the night workshop or Forge's owner is working. While a retouch runs, those wait.
- Mask: drawn with a finger on a canvas at the image's natural size (brush, Annuler, Effacer, Inverser), sent once as a PNG in the POST body, thresholded to black/white on the server.
- Normal source: the result goes to the gallery with `origin.inpaint_of`. Private source: decrypted in memory, mask and request built in memory, no temp file, result encrypted straight into the vault. No job record, history, gallery entry, stats, logs or browser storage; the retouch state lives only in memory and the dialog is wiped when the vault locks.

## Phase J: briques, généalogie, style maison, mode canapé

### J1 Briques de prompt
- Routes (admin + CSRF, 401/403/404 tested): `GET /api/forge/bricks`, `POST /api/forge/bricks` (`action`: create, update, delete), `GET /api/forge/bricks/loras`. Anything else under `/api/forge/bricks/` is 404.
- Storage: `.hq-forge/bricks.json` (version 1, at most 60 bricks), written atomically; a malformed file is kept and blocks writes. A brick is a name, a text, optionally a LoRA (`name`, weight -2..2) and up to 8 trigger words. No prompt, image or job reference is stored.
- Touching a brick only appends `<lora:name:weight>, words, text` to the prompt field; no job is started.
- Trigger word suggestions: the 6 most frequent training tags in the LoRA file's own metadata (`ss_tag_frequency`), read through the already allowlisted read-only `GET /sdapi/v1/loras` on this PC's Forge. No worker is asked, no new Forge route. Suggestions only; the owner picks. Unverified on a real LoRA file (mock metadata only).
- Private mode: bricks can be added to a private prompt (in the page only) but cannot be saved; the editor is never prefilled from the prompt.

### J2 Généalogie d'une image
- Route (admin, read-only; 401/403/404 tested): `GET /api/forge/gallery/<img-id>/lineage`. Unknown ids and vault ids (`pvt-...`) are 404; POST is 404.
- Built from links the gallery already stores in `meta.json`: `origin.finish_of` (finition, E) and `origin.inpaint_of` (retouche, I). Nothing new is written. Variations (C) record no parent and are not linked. The tree starts at the oldest ancestor still in the gallery (a deleted start image is reported), is cycle-safe and capped at 200 nodes; it carries ids, relation, date, sort flag and thumb URL only (no prompt or settings).
- Private: the vault is never traversed. A private retouch records no gallery origin, so private lineage is excluded rather than shown.

### J3 Style maison
- Route (admin, read-only; 401/403/404 tested): `GET /api/forge/house-style`. POST and sub-paths are 404.
- Indicatif: the most common sampler, scheduler, size, steps and CFG among normal gallery images sorted keep or favorite (a favourite counts twice), with « n sur m » shares; at least 5 kept images. The most kept model is shown but never applied; a negative prompt is offered only when it is the habit (at least 40 %).
- Applying fills the form's technical fields through the existing `applyTechnical` hook (no checkpoint); « Reprendre son prompt négatif » fills the negative field. Nothing starts a job.
- Only gallery `meta.json` is read. The vault is never read, so private settings and prompts never shape the style.

### J4 Mode canapé
- No route. A page-side display choice (`#forge-studio.is-couch`, toggle « Mode canapé » / « Quitter le mode canapé », `aria-pressed`): prompt, destination, Générer, results and gallery only, with larger type and 56-64 px targets. Hidden settings still apply to jobs (tested), and a note says so.
- Only the on/off choice is kept on the device (`localStorage.hqForgeCouch = "1"`); no prompt is stored.
- Auth and sessions are untouched: the script sends no request, sets no timer, never reads or writes cookies, and the studio's idle lock and session code never read the flag (static and browser tests). Without a session the API still answers 401.
