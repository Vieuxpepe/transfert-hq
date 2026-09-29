# Carnet local-agent launchers

These are the only prompts the user should normally paste into a local coding agent.

## Builder

```text
Work in the current Transfert HQ repo.
Read docs/carnet-agents/START-HERE.md, then ONLY the files listed there for <STAGE_FILE>.
Execute that stage exactly. Use INTEGRATION-MAP rg anchors before opening large files; use frozen CONTRACTS/DOM/FIXTURES instead of inventing alternatives.
Do not read the verbose playbook/design unless the stage explicitly says a decision is ambiguous.
Edit source files directly in C:\Transfert on the existing main branch. Do not create/switch branches, worktrees, or clones. Do not touch live runtime data (Inbox/Uni/Print/state files) except through throwaway test roots.
Keep commentary minimal: start state, material blocker/finding only, then compact HANDOFF-format completion.
```

Replace `<STAGE_FILE>` with e.g. `docs/carnet-agents/02-editor.md`.

## Reviewer

```text
Review the current Carnet stage adversarially.
Read docs/carnet-agents/START-HERE.md, REVIEW.md, HANDOFF.md, the current stage packet, and only that stage's files from the read matrix; inspect the complete diff against the accepted base.
Do not read the builder transcript. Report defects before editing; then fix only confirmed in-scope defects and rerun required tests.
No merge/deploy. Finish in compact HANDOFF format.
```

## Delivery

```text
Run docs/carnet-agents/DELIVERY.md for the current reviewed stage.
Read only the current stage's START-HERE matrix files. Do not redesign anything.
If any required check is red, stop. Stay on main. Commit and/or push main only if explicitly authorized; otherwise leave reviewed changes uncommitted in the current working tree. Never merge/deploy.
```

## Preflight

```text
Run docs/carnet-agents/00-preflight.md in the current Transfert HQ repo.
Read only the Stage 00 files listed in START-HERE.md. Do not modify files.
Return only the compact outputs requested by the preflight packet.
```

## Quota rules

- Never paste design.md into the prompt.
- Never paste the old 2,300-line playbook.
- Let the agent read repository files locally.
- Start fresh context for builder and reviewer.
- Carry forward only HANDOFF facts.
