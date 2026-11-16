# Robotique Hardware Commissioning Checklist

- **Repository:** `Vieuxpepe/transfert-hq`
- **Branch:** `fix/robotics-safety-phase0`
- **Software Baseline Commit:** `a7bf6ed`
- **RoArm-M2-S Firmware Version:** `[PENDING — RECORD ON BENCH]`
- **Hardware Execution Gate:** **DISABLED** until Gate 2 and Gate 3 are signed `PASS` (any merge of software changes to `main` requires separate authorization and must keep hardware execution disabled until commissioning is signed off).

---

## Gate 2 — Electrical & Mechanical Inspection *(Power Off / Isolated)*

- **Gate 2 Status:** **NOT VERIFIED**
- **Pass only when:** The protective stop circuit and mechanical supports have been inspected and demonstrated safe under the intended failure conditions, with power-off and gravity hazards addressed.

| ID | Check | Procedure | Pass Criterion | Status | Measured Result | Instrument Used | Evidence File | Pass/Fail | Test Operator | Reviewer | Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **G2.1** | **Independent E-Stop & Gravity Safety** | Trace physical normally-closed (NC) E-stop wiring to motor/actuator power relay (independent of PC, Python, HTTP, and `/estop` monitor); test actuation under mechanical catch. | Opening NC circuit stops hazardous motion independently of software **without creating an uncontrolled gravity-drop hazard**. | NOT VERIFIED | | | | | | | |
| **G2.2** | **Mechanical Containment & Drop Support** | Place arm in neutral and extended poses with physical support/catch covering the full potential drop path; remove power/torque. | Support contains full potential movement with zero pinch/impact hazard before motor power is enabled. | NOT VERIFIED | | | | | | | |
| **G2.3** | **Cable Routing & Reach Envelope** | Gently articulate all 4 joints by hand within `LIMITS` (`base ±80°`, `shoulder ±55°`, `elbow -25..155°`, `hand 70..260°`) while strictly respecting manufacturer mechanical limits and physical constraints (never force against hard stops or binding). | Zero cable snag, zero mount collision, and clearance matches `WORKSPACE` (`x: 45..500`, `y: ±450`, `z: 25..490`) within manufacturer mechanical limits. | NOT VERIFIED | | | | | | | |
| **G2.4** | **Supervisory `/estop` Monitor (Separate Timing)** | Power `/estop` monitor only; test `GET /estop` (`estop_require_signed` on/off) and open/unplug contact. | Monitor HTTP reply/timeout (`<= 0.3 s`) and controller supervisor detection/latch time measured **separately**; open/unreachable contact latches `stop_latched=True` without UI polling. | NOT VERIFIED | | | | | | | |

---

## Gate 3 — Instrumented Unloaded Bench Commissioning *(Low-Speed, Secured, Unloaded)*

- **Gate 3 Status:** **NOT VERIFIED**
- **Pass only when:** Recorded measurements demonstrate acceptable stopping behavior, joint motion, feedback quality, and fault recovery against limits established from actual hardware and a documented risk assessment.

| ID | Check | Procedure | Pass Criterion | Status | Measured Result | Instrument Used | Evidence File | Pass/Fail | Test Operator | Reviewer | Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **G3.1** | **`T:105` Torque Telemetry (Strict Default)** | Query `T:105` in idle, energized, and `T:210 cmd:0` states with `torque_telemetry_required=True`. | All 4 `torswitchB/S/E/H` fields present and `0/1` accurate. Missing `torswitch*` fails commissioning unless a documented engineering exception and alternative verification are signed. | NOT VERIFIED | | | | | | | |
| **G3.2** | **`T:210 cmd:0` Gravity & Re-enable Behavior** | With mechanical support covering full potential drop path at `HOME` and partial extension, issue `POST /api/robotics/stop` (`T:210 cmd:0`). | Document hold/creep/drop behavior under full containment; verify software blocks rearming until `reset({"inspected": true})` (and note any firmware or external interface torque re-enable behavior). | NOT VERIFIED | | | | | | | |
| **G3.3** | **Stop & Lock-Hold Latency (Measured Separately)** | Inject slow/blocked/timed-out `arm.move()` during `stream()`, trigger `POST /api/robotics/stop` and physical E-stop. | Measure separately: (a) hardwired E-stop cut time, (b) `arm.move()` lock-hold delay, (c) `stop()` `io.acquire(timeout=3.2)` wait, (d) supervisor latch delay — all within documented risk-assessment limits. | NOT VERIFIED | | | | | | | |
| **G3.4** | **`T:105` Settling vs. Confirmed Standstill** | Command `3°` unloaded move at `speed=60`; observe actual motion with an **independent** instrument (must not contend with `self.io` command stream). | Distinguish `REACHED_DEGREES = 2.0°` (position arrival tolerance), the `0.08°` stationary-dwell epsilon across `0.35 s`, and **confirmed physical standstill**; verify moving samples never clear `physical_command_sent`. | NOT VERIFIED | | | | | | | |
| **G3.5** | **Joint Synchronization** | Command diagonal `3°–5°` step (`base + shoulder + elbow`) and observe actual joint trajectories independently. | Document whether firmware interpolates synchronously or slews axes independently; retain `async_box_clearance` regardless. | NOT VERIFIED | | | | | | | |
| **G3.6** | **PTZ `<Timeout>` & Tapo TLS Pin** | Trigger `camera/ptz` pulse while dropping follow-up `Stop`; read Tapo leaf cert SHA-256. | Camera halts within `PTnS` device timeout; `camera_tls_sha256` pinned and verified. | NOT VERIFIED | | | | | | | |

---

## Formal Sign-Off Record

| Role | Name | Signature | Date | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Test Operator** | | | | |
| **Safety Reviewer** | | | | |
| **Hardware Gate Authorization** | | | | Hardware execution remains **DISABLED** until signed `PASS`. |
