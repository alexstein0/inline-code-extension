# VS Code Extension — Inline Code Suggestions

## Architecture

- **Extension runs on the user's local Mac**, not on the cluster
- **Model server runs on the cluster** (e.g., cml12:8321), tunneled to localhost via SSH
- User pulls changes from GitHub to their local machine, then rebuilds/runs with F5
- After making changes here, **commit and push** so the user can pull

## Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point, registers commands (Tab accept, Escape dismiss) |
| `src/suggestionProvider.ts` | Orchestrates: debounce → request → show preview → accept/dismiss |
| `src/decorationRenderer.ts` | Applies edits as live previews with green highlight, handles undo on dismiss |
| `src/modelClient.ts` | HTTP client to the model server (`/predict`, `/notify`) |
| `src/types.ts` | Shared types: `Change`, `Suggestion`, `PredictRequest`, etc. |

## Server Protocol

The model server returns JSON with:
- `edit_line`: 0-indexed line number
- `edit_col`: 0-indexed column
- `action`: `"insert"` | `"delete"` | `"replace"`
- `content`: text for insert/delete
- `delete` / `insert`: text for replace actions
- `before` / `after`: context strings (for history, not used in rendering)

The extension can toggle between different model endpoints.

## Content Format Convention

The model produces insert content starting with `\n` (e.g., `"\n    if train:"`). This means "insert new lines before the target line." The renderer normalizes this by stripping the leading `\n` and adding a trailing `\n` so VS Code's `eb.insert()` pushes existing content down correctly.

## Preview Strategy

- **Insert/Replace**: Edit is applied immediately with a green highlight. Dismiss reverses it via undo edit.
- **Delete**: Only highlighted (red) during preview. Actually applied on accept.
- Jump indicator shows `↓ Tab → line N` when edit is far from cursor.

## Build & Run

```bash
# In the vscode-extension/ directory on local machine:
npm install
npx tsc          # or Ctrl+Shift+B in VS Code
# Then F5 to launch Extension Development Host
```

`tsconfig.json` requires `"types": ["node", "vscode"]` — without this, `console`, `setTimeout`, `fetch` etc. won't resolve.

## Gotchas

- `node_modules/` is checked into git (small dependency set) — don't add heavy deps without considering this
- The `out/` directory contains compiled JS — rebuild after any TS changes
- Content normalization (leading `\n` → trailing `\n`) must be applied in both `decorationRenderer.ts` and `suggestionProvider.ts` (cursor positioning)
