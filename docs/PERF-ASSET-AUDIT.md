# Asset audit (read-only, nothing deleted)

Measured on commit `64b45d0`: 2,954 tracked files, 639 MB (`assets/` 630 MB, `tests/` 5 MB).

## Exact duplicates (same SHA-1, files >= 64 KB)

186 groups, about **250 MB redundant**, all under `assets/companion/chat/`:
`lewd_wav_bank/<phase>/<name>.wav` is byte-identical to `voice_cache/master_voice_<hash>.wav`.

| Class | Path | Evidence | Verdict |
|---|---|---|---|
| Required runtime resource | `assets/companion/chat/lewd_wav_bank/**` | listed in `manifest*.json`, referenced by `assets/hq-companion.js` | keep |
| Reproducible cache (generated) | `assets/companion/chat/voice_cache/master_voice_*.wav` (347 files) | written by `hq_voice.py` under a content hash; referenced by `tests/test_hq_voice.py`, `gen_lewd_bank.py`, `package_lewd_bank.py` | candidate to stop tracking |
| Frozen snapshots | `artifacts/**`, `_backup_*` | older copies of scripts and assets | keep until the owner confirms |

## Recommended, NOT executed

1. Confirm in `hq_voice.py` that a missing `voice_cache` entry is regenerated (or re-copied from `lewd_wav_bank`) rather than failing.
2. If so: `git rm -r --cached assets/companion/chat/voice_cache` plus a `.gitignore` entry. Working files stay on disk and the repository sheds about 250 MB.
3. Optionally generate a manifest of `sha1 -> canonical path` so the cache can be rebuilt by copy.

Not recommended: Git LFS (deployment is a plain checkout served by the bridge; LFS would need client setup).
