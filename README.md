# SQL Column Hints

Shows the column name inline in front of every value in a SQL `INSERT`, the same way an IDE shows named-parameter hints in a function call.

Reviewing a wide `INSERT` normally means counting commas up in the column list to work out which value is which:

```sql
INSERT INTO `wallet` (`id`, `user_id`, `wallet_rule_id`, `status`, `name`) VALUES
  (1, 1, 10, 1, 'Demo'),
```

With this extension the editor shows it as:

```sql
  (id: 1, user_id: 1, wallet_rule_id: 10, status: 1, name: 'Demo'),
```

The column names are inlay hints — virtual text drawn by the editor. The file on disk is untouched, and copying the line copies only the SQL.

It also flags rows whose value count doesn't match the column list, which is usually the bug people are counting commas to find in the first place.

## Install

**From the packaged file:** download the `.vsix` from this repository's **Releases** page, then
`code --install-extension sql-column-hints-0.2.0.vsix` — or in VS Code: Extensions view → `...` menu → **Install from VSIX…** → pick the file → reload.

**From source:**

```bash
npm install
npm run compile
npm test              # optional: 15 parser tests + 18 extension smoke tests
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, and open `samples/wallet.sql`.

Inlay hints must be on in VS Code itself — `"editor.inlayHints.enabled": "on"` (the default; `"onUnlessPressed"` and `"offUnlessPressed"` toggle them with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>).

## Commands

| Command | What it does |
| --- | --- |
| `SQL Column Hints: Toggle Inline Column Names` | Flips `sqlColumnHints.enabled` globally |
| `SQL Column Hints: Show All Hints` | Sets `editor.inlayHints.maximumLength` to `0` so wide rows aren't clipped (see below) |

## Hints stop after the first few columns?

That's VS Code, not this extension. The editor truncates inlay hints once their
**combined label length on one line** passes `editor.inlayHints.maximumLength`,
which defaults to **43 characters** — *"Maximum overall length of inlay hints,
for a single line, before they get truncated by the editor. Set to `0` to never
truncate."*

On a wide `INSERT` the budget is gone almost immediately:

```
id:(3) + created_at:(11) + created_user_id:(16) + name:(5) = 35
description:  -> clipped to "descript…" at 43
status:       -> dropped entirely
```

The extension detects this and offers to fix it; you can also run **SQL Column
Hints: Show All Hints**, or set it yourself:

```jsonc
{
  "editor.inlayHints.maximumLength": 0  // 0 = never truncate
}
```

It's a global editor setting, so it lifts the limit for every extension's inlay
hints. If you'd rather keep a budget, raise it to something that fits your
widest table (`"editor.inlayHints.maximumLength": 400`) or shorten the labels
with `sqlColumnHints.maxColumnNameLength`.

One more editor-side cap worth knowing: VS Code renders at most 1500 inlay hint
decorations at a time, so on a very wide table only the first ~60 rows in view
get hints regardless of `sqlColumnHints.maxRowsPerStatement`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `sqlColumnHints.enabled` | `true` | Master switch for hints and diagnostics |
| `sqlColumnHints.languages` | `["sql","mysql","postgres","pgsql","sqlite","jinja-sql"]` | Language IDs the provider attaches to (reload window after changing) |
| `sqlColumnHints.hintPosition` | `"before"` | `before` → `id: '93'`; `after` → `'93' :id` |
| `sqlColumnHints.maxColumnNameLength` | `32` | Longer column names are truncated with `…` |
| `sqlColumnHints.maxRowsPerStatement` | `500` | Only the first N rows of a statement get hints (dump-file guard) |
| `sqlColumnHints.maxFileSizeKB` | `4096` | Files above this size are skipped entirely |
| `sqlColumnHints.skipHintsForRowsInsideSelection` | `false` | Hide hints on the line the cursor is on, so text doesn't shift while typing |
| `sqlColumnHints.warnAboutEditorHintLimit` | `true` | Offer to raise `editor.inlayHints.maximumLength` when it's clipping hints |
| `sqlColumnHints.diagnostics.enabled` | `true` | Report column/value count mismatches in the Problems panel |
| `sqlColumnHints.diagnostics.severity` | `"warning"` | `error` / `warning` / `information` / `hint` |

## What it understands

Handled:

- Multi-row, multi-line `INSERT ... (cols) VALUES (...), (...)`, including statements split over hundreds of lines
- Quoting styles: `` `mysql` ``, `"ansi"`, `[tsql]`, bare identifiers; `schema.table` prefixes
- Commas and parentheses **inside** string literals and function calls — `CONCAT('a', ',', '(b)')` counts as one value, `NOW()` counts as one value
- Escaped quotes (`'it''s'` and `'back\'slash'`), `--`, `#` and `/* */` comments, Postgres `$tag$` bodies
- `INSERT IGNORE`, `REPLACE INTO`, `INSERT OR REPLACE`, `ON DUPLICATE KEY UPDATE` tails
- Non-ASCII values and identifiers (Cyrillic, Mongolian, etc.)

Deliberately not annotated (no column list to map values onto):

- `INSERT INTO t VALUES (...)` without an explicit column list
- `INSERT ... SELECT` and `INSERT ... SET a = 1`
- `UPDATE` / `WHERE` clauses

## How it works

`src/sqlParser.ts` is a dependency-free lexer plus a small `INSERT` recogniser. It has no `vscode` import, so it's testable under plain Node (`test/parser.test.js`) — a single-pass character scanner, no regex backtracking, and a 5,000-row / 178 KB dump parses in ~35 ms.

`src/extension.ts` wraps it in an `InlayHintsProvider`. Each document is parsed at most once per version and cached, since VS Code re-requests hints on every scroll; rows outside the requested viewport range are rejected by offset before any `Position` objects are built. Diagnostics are recomputed on a 250 ms debounce.

## Trade-offs worth knowing

- **Inlay hints, not decorations.** They respect the user's `editor.inlayHints` setting, can't be selected or copied by accident, and get the same theming as parameter hints elsewhere. The cost is that they're off for anyone who has disabled inlay hints globally.
- **A hand-rolled parser, not a SQL grammar.** A real grammar (e.g. `node-sql-parser`) would reject invalid SQL and understand every dialect, but it also fails hard on half-typed statements and adds a dependency an editor extension has to load on startup. This scanner degrades gracefully: an unterminated string or an unclosed paren simply produces no hints for that statement instead of throwing.
- **No schema awareness.** Column names come from the statement's own column list, not from a live database connection. That's why `INSERT INTO t VALUES (...)` gets nothing.

## License

MIT
