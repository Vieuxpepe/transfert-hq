# Carnet agents — START HERE

Purpose: minimize local-agent quota while preserving the full Carnet design.

## What an implementation agent reads

For one implementation stage, read ONLY:

1. \`docs/carnet-agents/CONTEXT.md\`
2. the current stage file (\`01-core.md\`, \`02-editor.md\`, ...)
3. \`docs/carnet-agents/TESTS.md\`
4. the previous accepted \`HANDOFF.md\` content, if any
5. only the source-code slices named by the stage prompt

Do **not** read the full 1,400-line \`design.md\` unless the stage says a decision is ambiguous or current code contradicts the packet.

Do **not** read \`docs/carnet-agent-playbook.md\`; it is the verbose archive.

## Sequence

00 preflight → 01 core → 02 editor → 03 library → 04 rich → 05 sources → 06 media → 07 engineering → 08 history/reports.

After every implementation stage, use \`REVIEW.md\`. Use \`DELIVERY.md\` only when explicitly authorized to commit/push/open a Draft PR.

## Context discipline

- One fresh coding-agent context per stage.
- One fresh reviewer context per review.
- Builder gets the stage packet, not the conversation.
- Reviewer gets the diff + stage packet, not the builder's narrative.
- Never ask an agent to "improve anything else".
- Future-stage ideas stay out of the current stage.

## Product invariant

**paper, cursor, type.**

Advanced features may be powerful; opening Carnet must stay immediate and quiet.
