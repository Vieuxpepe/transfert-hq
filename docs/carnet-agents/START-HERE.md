# Carnet agents — START HERE

Purpose: minimize local-agent quota while preserving the full Carnet design.

## Working-tree mode

Work directly in the checked-out project folder `C:\\Transfert` on the existing `main` branch.
Source files in `C:\\Transfert` are the intended edit target; live runtime data under that same root is not.
Do not create, switch, or use feature branches, worktrees, or extra clones for Carnet stages.
Do not commit, push, merge, reset, clean, checkout files, or alter unrelated working-tree changes unless the user explicitly asks.
All stages build incrementally in the same local working tree after the previous stage is accepted.


## Stage read matrix

Read ONLY the files for the current stage.

| Stage | Read |
|---|---|
| 00 preflight | CONTEXT, INTEGRATION-MAP, TESTS, 00-preflight |
| 01 core | CONTEXT, INTEGRATION-MAP, CONTRACTS, FIXTURES, TESTS, HANDOFF, 01-core |
| 02 editor | CONTEXT, INTEGRATION-MAP, CONTRACTS, DOM-CONTRACT, FIXTURES, TESTS, HANDOFF, 02-editor |
| 03 library | CONTEXT, DOM-CONTRACT, FIXTURES, TESTS, HANDOFF, 03-library |
| 04 rich | CONTEXT, CONTRACTS, DOM-CONTRACT, FIXTURES, TESTS, HANDOFF, 04-rich |
| 05 sources | CONTEXT, CONTRACTS, FIXTURES, TESTS, HANDOFF, 05-sources |
| 06 media | CONTEXT, CONTRACTS, DOM-CONTRACT, TESTS, HANDOFF, 06-media |
| 07 engineering | CONTEXT, DOM-CONTRACT, TESTS, HANDOFF, 07-engineering |
| 08 history | CONTEXT, TESTS, HANDOFF, 08-history |

Do **not** read the full 1,400-line `design.md` unless a stage says a product decision is ambiguous or current code contradicts the packet.

Do **not** read `docs/carnet-agent-playbook.md`; it is the verbose archive.

Do not read files from future stages.

## Sequence

00 preflight → 01 core → 02 editor → 03 library → 04 rich → 05 sources → 06 media → 07 engineering → 08 history/reports.

After every implementation stage, use `REVIEW.md`. Use `DELIVERY.md` only when explicitly authorized to commit and/or push `main`.

## Context discipline

- One fresh coding-agent context per stage.
- One fresh reviewer context per review.
- Builder gets stage packet + only matrix files above, not the conversation.
- Reviewer gets diff + stage packet, not builder narrative.
- Never ask an agent to "improve anything else".
- Future-stage ideas stay out of current stage.
- Use `rg` anchors from INTEGRATION-MAP before opening large files.
- Prefer canonical selectors/payloads/fixtures instead of inventing alternatives.

## Product targets

Carnet is one synchronized notebook across Windows PC, iPad and iPhone. `iphone_bridge.py` is a shared server filename, not an iPhone-only target.

## Product invariant

**paper, cursor, type.**

Advanced features may be powerful; opening Carnet must stay immediate and quiet.
