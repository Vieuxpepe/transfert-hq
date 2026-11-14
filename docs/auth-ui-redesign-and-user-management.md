# Transfert HQ — Authentication UI Redesign & User Management

## Overview

This implementation delivers a complete visual and security overhaul of the Transfert HQ authentication system, introducing a modern, accessible login experience and an administrative user management interface with slow KDF credential protection, strict administrator lockout prevention, and surgical session revocation.

---

## 1. Redesigned Login Interface

The login interface (`render_login`) has been transformed from a basic utility prompt into a modern, refined web experience built to Transfert HQ's visual specifications:

- **Visual Design**: Premium dark theme (`--bg: #0a0d14`, `--surface: #121824`) with refined violet and pink ambient lighting (`radial-gradient` accents in `#a855f7` and `#ec4899`).
- **Transfert HQ Branding**: Lockup with security shield mark, clear typography, and contextual subtitle.
- **Accessible PIN Input**: High-contrast, large-font PIN input field (`1.5rem`) with letter spacing, `type="password"`, `inputmode="numeric"`, `pattern="[0-9]*"`, `autocomplete="current-password"`, and accessible label.
- **Show / Hide Control**: Interactive toggle button with inline SVG eye/eye-off icons and dynamic `aria-label` updates for screen readers.
- **Submission & Loading State**: Clear interactive feedback with button disablement, subtle loading spinner, and French copy (`Connexion en cours…`).
- **Cross-Device Responsiveness**: Full responsiveness across iPhone Safari, installed PWA (`viewport-fit=cover`, dynamic viewport units `100dvh`), tablet, and desktop.
- **Self-Contained & Privacy-Preserving**: Zero external assets, fonts, or CDN dependencies. No credentials stored in `localStorage`, `sessionStorage`, URLs, or analytics.
- **Protocol Parity**: Preserves CSRF origin verification, brute-force rate limiting (`AuthRateLimiter`), secure session cookies, and the Safari HTTP 303 redirect.

---

## 2. Admin-Only Users & PINs Management

A discoverable management interface is integrated under **Système → Sécurité & PINs** (`#system-security`):

- **Role Gating**:
  - The UI section and navigation jump button are rendered exclusively for accounts with the `admin` role (and removed on the client for non-admin accounts).
  - All `/api/admin/users*` endpoints strictly reject unauthorized requests with HTTP `401 Unauthorized` (anonymous) and `403 Forbidden` (`upload` role).
- **Administrative Operations**:
  - **Add Account**: Display name (up to 40 characters), role (`admin` or `upload`), minimum 8-character PIN, verified by current admin's PIN.
  - **Edit Account**: Rename display names, promote `upload` accounts to `admin`, demote `admin` accounts to `upload`, or toggle active/disabled states.
  - **Change PIN**: Securely rotate credentials with strength and duplicate checks, without exposing existing PINs or hashes.
  - **Revoke Sessions**: Surgically terminate all active sessions for a target user without impacting other logged-in users.
  - **Delete Account**: Permanently remove accounts with confirmation and automated session purging.
  - **Account Metadata**: Real-time display of role badges, active session counts, enabled/disabled status, and account IDs.
- **Sensitive Action Reauthentication**:
  - Every destructive or credential-modifying operation requires verification of the current administrator's PIN on the server side (`admin_pin`). Client-only validation is rejected.

---

## 3. Administrator Lockout Prevention

A critical design requirement is ensuring that existing single-PIN systems and newly expanded multi-user setups never lock out the administrator.

- **Automated Safe Migration (`migrate_users_config`)**:
  - Detects legacy root `CONFIG["pin"]` and empty or incomplete `CONFIG["users"]`.
  - Automatically migrates the legacy root administrator credential into a structured account (`id: "usr_admin"`, `name: "Administrateur"`, `role: "admin"`, `enabled: true`) with salted KDF hash.
  - Creating the first additional user (e.g. an `upload` account) **never disables or removes the original administrator account**.
- **Dual-Layer Authentication Fallback**:
  - `authenticate_pin` prioritizes active accounts in `CONFIG["users"]`.
  - If no user matches, it evaluates against legacy root `CONFIG["pin"]` using constant-time verification.
- **Last-Administrator Invariants**:
  - The system prevents deleting the final enabled administrator account (`count_enabled_admins <= 1`).
  - The system prevents disabling the final enabled administrator account.
  - The system prevents demoting the final enabled administrator account to `upload`.
- **Atomic Operations & Recovery**:
  - Configuration updates use atomic temporary file replacement (`_atomic_write` and `.bak` preservation).
  - Malformed or corrupted records in `CONFIG["users"]` are safely normalized without aborting service or dropping valid accounts.

### Safe Recovery Instructions (Break-Glass)

If unexpected configuration corruption occurs:
1. Open `bridge_config.json` in an editor on the host machine.
2. Under `"users"`, locate the administrator account or add:
   ```json
   {
     "id": "usr_admin",
     "name": "Administrateur",
     "role": "admin",
     "enabled": true,
     "pin": "VOTRE_NOUVEAU_PIN_8_CHIFFRES"
   }
   ```
3. Alternatively, restore `bridge_config.json` from `.bridge_config.json.bak`.
4. When the bridge reloads, `migrate_users_config` will automatically hash the plaintext PIN with `scrypt` and wipe the plaintext entry.

---

## 4. Cryptographic Storage & Credential Verification

- **Standard-Library Salted KDF**:
  - Primary algorithm: `hashlib.scrypt` with documented production parameters:
    - $N = 16384$ (CPU/memory cost factor, $2^{14}$)
    - $r = 8$ (block size)
    - $p = 1$ (parallelization)
    - `maxmem = 32 MB`
    - Salt: 16 bytes (128 bits) of cryptographically secure random bytes via `secrets.token_bytes(16)`.
    - Format: `scrypt$16384$8$1$<salt_hex>$<hash_hex>`.
  - Fallback algorithm: PBKDF2-HMAC-SHA256 with 100,000 rounds (`pbkdf2$sha256$100000$<salt_hex>$<hash_hex>`).
- **Constant-Time Verification**:
  - All comparisons use `hmac.compare_digest` to prevent timing side-channel attacks.
- **PIN Complexity & Duplicate Prevention**:
  - Minimum length: 8 characters (digits or passphrase), maximum 128.
  - Rejection of trivial sequences (e.g., `00000000`, `12345678`, `87654321`).
  - Server-side duplicate PIN prevention across all active accounts (`check_duplicate_pin`).
- **Data Protection Guarantee**:
  - Credential hashes and PINs are **never** returned in API responses, logs, or rendered HTML.

---

## 5. Surgical Session Security

- **Tied to Internal Account IDs**:
  - Sessions track `user_id`, guaranteeing that account renames do not accidentally transfer permissions or cause identity collisions.
- **Surgical Invalidation**:
  - Rotating an account's PIN purges only that account's active sessions (`revoke_sessions_for_user`).
  - Demoting or disabling an account immediately revokes all of its sessions.
  - Active sessions of unrelated users remain untouched, preventing unintended global disconnections.
- **Zero Stale Permissions**:
  - Every request checked by `session_info` validates account enabled status and role matching in real time. If an account is disabled or demoted, the session is invalidated immediately.

---

## 6. Security Telemetry

Structured security logging (`SecurityLog`) has been extended to record account lifecycle events:

- `auth.account.created`: Account creation.
- `auth.account.deleted`: Account deletion.
- `auth.account.disabled`: Account disabling.
- `auth.account.enabled`: Account enabling.
- `auth.account.pin_rotated`: PIN credential rotation.
- `auth.account.role_changed`: Account promotion or demotion.
- `auth.account.renamed`: Account display name change.
- `auth.account.sessions_revoked`: Explicit session revocation.

All entries record the actor role, request ID, timestamp, outcome, and sanitized nonsecret identifiers (`actor_user_id`, `target_user_id`). Credentials, hashes, session cookies, and request bodies are strictly excluded.

---

## 7. Test Verification Summary

- `tests/test_hq_users_security.py`: 9 unit tests verifying KDF hashing, PIN validation, duplicate detection, migration, last-admin protection, and surgical session revocation.
- `tests/test_auth_ui_management_http.py`: 11 end-to-end integration tests verifying iPhone/desktop login rendering, HTTP 303 redirects, legacy migration, lockout prevention, role authorization, reauthentication, CSRF validation, and credential absence.
- Full regression suite across existing modules: 212 passed, 0 failures.
