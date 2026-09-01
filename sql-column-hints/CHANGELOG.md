# Changelog

## 0.2.0

- **Fix for "hints stop after ~5 columns".** VS Code truncates inlay hints once
  the combined label length on a line passes `editor.inlayHints.maximumLength`
  (default **43** characters — the editor's own limit, not this extension's).
  On a wide `INSERT`, `id:` + `created_at:` + `created_user_id:` + `name:`
  already spends 35 of those 43, so the next column name gets clipped (`descript…`)
  and every column after it is dropped silently.
  The extension now detects the overflow and offers to set the limit to `0`.
- New command: **SQL Column Hints: Show All Hints** — sets
  `editor.inlayHints.maximumLength` to `0` directly.
- New setting: `sqlColumnHints.warnAboutEditorHintLimit` (default `true`) to
  turn the offer off.

## 0.1.0

- Initial release: column-name inlay hints on `INSERT ... VALUES` rows, and
  diagnostics for rows whose value count doesn't match the column list.
