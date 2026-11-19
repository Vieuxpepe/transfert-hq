# Phase 5B Release Dispositions (Transfert-HQ v7)

**Date:** 2026-11-19  
**Branch:** `release/phase5b-remediation` (based on `d277e8f284aa933c1419eb1d166276b631503f47`)  
**Audit Reference:** Claude Opus 5.5 Phase 5 Final Independent Audit (`PHASE5_OPUS_FINAL_AUDIT.md`)

---

## 1. Deferred Recovery Items (Explicitly Excluded from This Release)

| Audit ID | Scope | Disposition | Rationale & Source Reference |
| :--- | :--- | :--- | :--- |
| **P5-02** | Honeypot decoy routes, micro-PoW challenge/verification, tarpit delays, AI-scraper User-Agent filtering, and `AiQuotaGuard` (`hq_security.py` + 13 `HoneypotTests`) | **DEFERRED** (dedicated branch & review) | Adds security-sensitive unauthenticated request handling (decoy routes, tarpit delays, PoW challenges) that has never run in production. Must ship on its own dedicated security branch with independent adversarial review rather than riding along with release stabilization. Source remains preserved under `refs/heads/recovery/pr44-draft-honeypot-cba2bf16` (`cba2bf1646df87d357839119e102dc65ba55e075`). |
| **P5-03** | Forge F1 fixed-port harness (`hq_forge_maintenance_authorization.py`, `tests/test_hq_forge_fixed_port_harness.py`, `tests/test_hq_forge_lifecycle_f1.py`) and background-tick diagnostics (`_record_background_error`, `tests/test_hq_background_diagnostics.py`) | **DEFERRED** | Not required for current single-operator release baseline and not actively used in production. Source remains ref-protected on `forge-lifecycle-fixed-port-harness` (`e48a542`) and `bridge/job-0010` (`db7dc72`). |

---

## 2. Robotics Physical-Safety Gate (BLOCKS HARDWARE MODE)

| Audit ID | Finding | Status | Mandatory Gate Before Enabling Hardware Mode |
| :--- | :--- | :--- | :--- |
| **P5-04** | Software emergency stop (`hq_robotics.py:1417`) skips the hardware torque-cut command (`403`) if the admin session lapsed or an emergency lockdown cleared active sessions. | **BLOCKS HARDWARE MODE** (not a merge blocker for simulation-only operation) | Hardware E-stop must cut actuator power independently of HQ and of session/lockdown state; software E-stop path for loopback physical callers must be decoupled from session freshness or explicitly documented as secondary to a verified independent hardware E-stop. |
| **P5-05** | `emergency_stop` (`T:210 cmd:0`) and `teach()` (`set_torque(False)`) both release servo torque without E-stop health, camera, or feedback preconditions (gravity drop risk on a 50 lb arm). | **BLOCKS HARDWARE MODE** | Before any powered motion on the 50 lb arm: verify mechanical brakes / counterbalance under load, implement a controlled-stop command, and enforce supported-pose + healthy-E-stop preconditions before torque release. |
| **P5-06** | `reset()` clears `teach_mode` without restoring servo torque and is not refused while in `teach_mode`, risking an abrupt snap-to-target on the next move if firmware auto-re-enables torque. | **BLOCKS HARDWARE MODE** | Refuse `reset()` while in `teach_mode` or require supervised `set_torque(True)` first; validate actual servo firmware behavior under a signed physical test plan. |

**Operational Rule:** Until P5-04, P5-05, and P5-06 are resolved and verified against the physical commissioning checklist (Gate 2/3), robotics **must remain in simulation mode only**. No hardware actuation, PWM limit change, or interlock bypass is authorized by this software release.

---

## 3. Resolved in Phase 5B (`release/phase5b-remediation`)

- **P5-01 (HIGH):** Selectively ported Family / voice / compact-state personhood from `cba2bf1` onto `hq_personhood.py` while retaining `"elsea"` in `DOMAIN_KEYS`/`VALUES`/`AXES`/`_domain_paths()`, `9cf90c0` owner-scoping, and `d277e8f` `persist=False` in `snapshot()`/`hint_detail()`. Verified `test_hq_family_state` (`40/40`), companion/personhood/elsea/visits/AI/sister suites (`274/274`), and `probe_strong.py` (`10/10`).
- **Preview Read-Only Regression Test:** Added `test_preview_with_expired_personhood_events_does_not_write` (with positive write-sensitivity assertion) to `tests/test_hq_companion_editor.py`.
- **P5-10 (MEDIUM):** Removed hardcoded `C:\Transfert\iphone_bridge.py` reads in `test_hq_forge_lifecycle*.py`, defaulted `HQ_M2A_EVIDENCE` to `%TEMP%`, and gated live `:8765`/`:7860` probes behind `HQ_LIVE_BRIDGE_PROBE=1`.
- **P5-12 (LOW):** Added `tests/hq_symlink_test_helper.py` (`@skip_without_symlinks`) to convert Windows `WinError 1314` symlink errors into clean `skipTest` across the 6 Carnet test modules (`485` tests: `0` FAIL, `0` ERROR).
- **P5-20 (LOW):** Confirmed `hq_language.DIRECTIVE` intentionally follows `ai.PRIORITE` when English-only mode is active; aligned `tests/test_hq_life.py` to assert `PRIORITE` stays last immediately before `hq_language.DIRECTIVE`.
- **P5-21 (LOW):** Fixed `hq_diagnostics.required_assets()` to include lazy `.css` assets alongside lazy `.js` assets so `/api/diag/ready` fails closed when a required stylesheet such as `hq-carnet.css` is missing (`test_smoke_deploy` PASS).
