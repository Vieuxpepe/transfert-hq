# Stage 01 accepted handoff

Accepted against original base:
`d7e7eb3f2a293303ab258c69fda7f104c245022d`

Checkpoint commit on local `main`:
`5ce460ec023219433f2343e509a6dd6679a6dfc4`

Working mode:
- local `C:\Transfert`
- branch `main`
- Stage 01 is checkpointed locally on `main` at `5ce460ec023219433f2343e509a6dd6679a6dfc4`; it is not pushed unless the user later authorizes push

Accepted substantive files:
- `.gitignore`
- `README.txt`
- `cc_ext.py`
- `hq_automation.py`
- `iphone_bridge.py`
- `hq_carnet.py` (new)
- `tests/test_hq_carnet.py` (new)

Core contract now true:
- V1 notebook at `<ROOT>/.hq-carnet/notebook.json`
- admin-only GET/POST API
- page and notebook optimistic revisions
- strict client-field validation
- UTF-8 byte caps and bounded collections
- category/project semantics from CONTRACTS
- malformed/unsupported storage preserved
- confined path checks cover notebook, directory and temp-path redirection
- backup status is separate from legacy `folders`; failed/invalid Carnet recovery snapshot blocks retention purge
- backup catalog persists Carnet status
- `api()` browser error.status/error.data is still owed in Stage 02

Accepted review tests:
- focused Carnet suite: 44 PASS
- full unittest discover: 335 PASS, 29 skipped
- relevant backup/security/v7 suites: PASS
- py_compile/SyntaxWarning: PASS
- Node feature/sketch/solid/3d-nav/model checks: PASS
- CRLF-safe diff check: PASS

Important environment rule:
- never execute Python imports/tests that can import `iphone_bridge` from live `C:\Transfert`
- use an isolated disposable source copy outside the live checkout

Known residuals:
- Windows junction/symlink behavior not physically exercised in review; platform-specific symlink tests skip if privileges are unavailable
- no push alert on Carnet backup failure; warning + purge block is the accepted Stage-01 behavior
