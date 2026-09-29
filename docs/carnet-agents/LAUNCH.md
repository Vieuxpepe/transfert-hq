# Carnet local-agent launchers

These are the only prompts the user should normally paste into a local coding agent.

## Builder

```text
Work in the current Transfert HQ repo.
Read docs/carnet-agents/CONTEXT.md, TESTS.md, HANDOFF.md, and <STAGE_FILE>.
Execute that stage exactly. Use its rg anchors; do not read the verbose playbook/design unless the packet says a decision is ambiguous.
Do not expand scope, merge, deploy, or touch live C:\Transfert.
Keep commentary minimal: start state, material blocker/finding only, then compact HANDOFF-format completion.
```

Replace `<STAGE_FILE>` with e.g. `docs/carnet-agents/02-editor.md`.

## Reviewer

```text
Review the current Carnet stage adversarially.
Read docs/carnet-agents/CONTEXT.md, REVIEW.md, HANDOFF.md, and the current stage packet; inspect the complete diff against the accepted base.
Do not read the builder transcript. Report defects before editing; then fix only confirmed in-scope defects and rerun required tests.
No merge/deploy. Finish in compact HANDOFF format.
```

## Delivery

```text
Run the Carnet delivery gate in docs/carnet-agents/DELIVERY.md for the current reviewed stage.
Use CONTEXT.md, TESTS.md, HANDOFF.md and the stage packet. Do not redesign anything.
If any required check is red, stop. Commit/push/open one Draft PR only if explicitly authorized. Never merge/deploy.
```

## Preflight

```text
Run docs/carnet-agents/00-preflight.md in the current Transfert HQ repo.
Read CONTEXT.md and TESTS.md only. Do not modify files.
Return only the five compact outputs requested by the preflight packet.
```

## Quota rules

- Never paste design.md into the prompt.
- Never paste the old 2,300-line playbook.
- Let the agent read repository files locally.
- Start a fresh context for builder and reviewer.
- Carry forward only HANDOFF.md-style facts.
