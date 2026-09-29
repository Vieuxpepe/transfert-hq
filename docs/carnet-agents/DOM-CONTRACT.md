# Carnet DOM / selector contract

Use these stable IDs/data attributes so implementation and Playwright tests do not invent different names.

## Static host inserted by server

\`\`\`html
<div data-panel="carnet">
  <section class="hq hq-carnet" aria-labelledby="carnet-title">
    <h2 id="carnet-title" class="visually-hidden">Carnet</h2>
    <div id="hq-carnet-app">
      <p class="hint">Chargement…</p>
    </div>
  </section>
</div>
\`\`\`

Feature JS owns descendants of \`#hq-carnet-app\`.

## Required stable selectors — Stage 02

Root:
- \`#hq-carnet-app\`
- \`.carnet\` feature root once initialized

Editor:
- \`#hq-carnet-editor\`
- \`data-page-id="<opaque id>"\`

Status:
- \`#hq-carnet-status\` with \`role="status"\` / polite live semantics

Navigation:
- \`#btn-carnet-prev\`
- \`#btn-carnet-next\`
- \`#btn-carnet-new\`
- \`#carnet-page-indicator\`

Metadata/actions:
- \`#btn-carnet-context\`
- \`#btn-carnet-pin\`
- \`#btn-carnet-library\`
- \`#btn-carnet-more\`
- \`#btn-carnet-copy\`

Quick tools:
- \`#carnet-quick-tools\`
- \`[data-carnet-symbol]\`
- \`#btn-carnet-time\`

Conflict:
- \`#hq-carnet-conflict\`
- \`#btn-carnet-conflict-remote\`
- \`#btn-carnet-conflict-local\`

Failure surface:
- \`.carnet-fail\`
- \`.carnet-retry\`

Animation ghost:
- \`.carnet-page-ghost[aria-hidden="true"]\`

## Stage 03

Library:
- \`#hq-carnet-library\`
- \`#hq-carnet-search\`
- \`#carnet-library-list\`
- \`[data-carnet-page-id]\`
- \`[data-carnet-filter]\`
- \`#btn-carnet-focus\`
- \`#btn-carnet-focus-exit\`

Context:
- \`#hq-carnet-context\`
- \`[data-carnet-project]\`
- \`[data-carnet-category]\`

Trash:
- \`[data-carnet-trash]\`
- \`[data-carnet-restore]\`
- \`[data-carnet-delete-permanent]\`

Home:
- \`#hq-carnet-home\`
- \`#btn-home-carnet-open\`
- optional \`#btn-home-carnet-new\`

## Stage 04+

Formatting controls should use data attributes rather than dozens of global IDs:
- \`[data-carnet-format="bold"]\`
- \`[data-carnet-format="italic"]\`
- etc.

Structured entity nodes:
- \`[data-carnet-link]\`
- \`[data-carnet-citation]\`
- \`[data-carnet-asset]\`
- \`[data-carnet-block-id]\`

## Rules

- Tests may rely on the selectors above.
- Do not encode note text into IDs/classes/data attributes.
- data attributes may contain opaque internal IDs only.
- never use innerHTML with note/source/user text.
- responsive layouts reuse the same logical controls/selectors; do not create separate mobile and desktop editors.
