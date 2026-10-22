# AGENTS.md

このリポジトリで AI エージェント（Claude Code・Codex など）が守ること。

<!-- ci-cost-agent-rules -->
## GitHub への出し方（CI の費用を減らすため・2026-10-22 福岡さん）
- PR は下書き（draft）で開き、作業が終わったら1回だけ ready にする（`gh pr create --draft` → `gh pr ready`）。直しを足すときは `gh pr ready --undo` してから push する。
- push は小分けにせず、まとまってから出す（CI が push ごとに回るため）。
- push する前に、手元で軽いチェック（`npm run typecheck`・`npm run lint`・`npm test`）を通す。E2E は CI に任せる。
