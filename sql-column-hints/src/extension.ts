import * as vscode from 'vscode';
import { InsertStatement, parseSql } from './sqlParser';

const CONFIG_SECTION = 'sqlColumnHints';
const DIAGNOSTIC_SOURCE = 'sql-column-hints';
const DEBOUNCE_MS = 250;

/**
 * VS Code (1.87+) truncates inlay hints per line once their combined label
 * length passes `editor.inlayHints.maximumLength` (default 43). On a wide
 * INSERT that silently swallows the last few column names, which looks like a
 * bug in this extension. We detect it and offer to raise the limit.
 */
const EDITOR_HINT_LENGTH_SETTING = 'inlayHints.maximumLength';
const SUPPRESS_TRUNCATION_PROMPT_KEY = 'sqlColumnHints.suppressTruncationPrompt';

interface Settings {
  enabled: boolean;
  languages: string[];
  hintPosition: 'before' | 'after';
  maxColumnNameLength: number;
  maxRowsPerStatement: number;
  maxFileSizeKB: number;
  skipHintsForRowsInsideSelection: boolean;
  warnAboutEditorHintLimit: boolean;
  diagnosticsEnabled: boolean;
  diagnosticSeverity: vscode.DiagnosticSeverity;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
  };
  return {
    enabled: cfg.get<boolean>('enabled', true),
    languages: cfg.get<string[]>('languages', ['sql']),
    hintPosition: cfg.get<'before' | 'after'>('hintPosition', 'before'),
    maxColumnNameLength: cfg.get<number>('maxColumnNameLength', 32),
    maxRowsPerStatement: cfg.get<number>('maxRowsPerStatement', 500),
    maxFileSizeKB: cfg.get<number>('maxFileSizeKB', 4096),
    skipHintsForRowsInsideSelection: cfg.get<boolean>('skipHintsForRowsInsideSelection', false),
    warnAboutEditorHintLimit: cfg.get<boolean>('warnAboutEditorHintLimit', true),
    diagnosticsEnabled: cfg.get<boolean>('diagnostics.enabled', true),
    diagnosticSeverity: severityMap[cfg.get<string>('diagnostics.severity', 'warning')] ?? vscode.DiagnosticSeverity.Warning,
  };
}

/**
 * Parses each document at most once per version. VS Code asks for inlay hints
 * on every scroll, so re-tokenizing a multi-megabyte dump each time would be
 * far too slow.
 */
class StatementCache {
  private readonly entries = new Map<string, { version: number; statements: InsertStatement[] }>();

  get(document: vscode.TextDocument): InsertStatement[] {
    const key = document.uri.toString();
    const cached = this.entries.get(key);
    if (cached && cached.version === document.version) {
      return cached.statements;
    }
    const statements = parseSql(document.getText());
    this.entries.set(key, { version: document.version, statements });
    return statements;
  }

  forget(document: vscode.TextDocument): void {
    this.entries.delete(document.uri.toString());
  }

  clear(): void {
    this.entries.clear();
  }
}

function truncate(name: string, max: number): string {
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1))}…`;
}

class ColumnHintsProvider implements vscode.InlayHintsProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.emitter.event;

  constructor(
    private readonly cache: StatementCache,
    private settings: Settings,
    /** Called when the editor's per-line hint budget would hide some hints. */
    private readonly onHintsTruncated: (limit: number) => void,
  ) {}

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): vscode.InlayHint[] {
    const s = this.settings;
    if (!s.enabled) {
      return [];
    }
    // `length` is in UTF-16 code units, close enough for a size guard.
    if (document.getText().length > s.maxFileSizeKB * 1024) {
      return [];
    }

    const statements = this.cache.get(document);
    if (token.isCancellationRequested) {
      return [];
    }

    const rangeStart = document.offsetAt(range.start);
    const rangeEnd = document.offsetAt(range.end);
    const cursorLines = s.skipHintsForRowsInsideSelection ? this.activeCursorLines(document) : undefined;

    const hints: vscode.InlayHint[] = [];

    for (const statement of statements) {
      if (statement.columns.length === 0 || statement.rows.length === 0) {
        continue;
      }

      const rowLimit = Math.min(statement.rows.length, s.maxRowsPerStatement);
      for (let r = 0; r < rowLimit; r++) {
        const row = statement.rows[r];

        // Cheap rejection: whole row outside the requested viewport range.
        if (row.close < rangeStart || row.open > rangeEnd) {
          continue;
        }

        for (let v = 0; v < row.values.length; v++) {
          const column = statement.columns[v];
          if (!column) {
            break; // more values than columns - flagged by diagnostics instead
          }
          const value = row.values[v];
          if (value.end < rangeStart || value.start > rangeEnd) {
            continue;
          }

          const anchorOffset = s.hintPosition === 'before' ? value.start : value.end;
          const anchor = document.positionAt(anchorOffset);
          if (cursorLines && cursorLines.has(anchor.line)) {
            continue;
          }

          const label = truncate(column.name, s.maxColumnNameLength);
          const hint = new vscode.InlayHint(
            anchor,
            s.hintPosition === 'before' ? `${label}:` : `:${label}`,
            vscode.InlayHintKind.Parameter,
          );
          if (s.hintPosition === 'before') {
            hint.paddingRight = true;
          } else {
            hint.paddingLeft = true;
          }
          hint.tooltip = new vscode.MarkdownString(
            `**${statement.table || 'table'}.${column.name}** — column ${v + 1} of ${statement.columns.length}, row ${r + 1}`,
          );
          hints.push(hint);
        }

        if (token.isCancellationRequested) {
          return hints;
        }
      }
    }

    if (s.warnAboutEditorHintLimit) {
      this.reportEditorTruncation(document, hints);
    }

    return hints;
  }

  /**
   * VS Code drops inlay hints once a line's combined label length exceeds
   * `editor.inlayHints.maximumLength`. Nothing this extension returns can work
   * around it, so detect the overflow and let the caller offer the real fix.
   */
  private reportEditorTruncation(document: vscode.TextDocument, hints: vscode.InlayHint[]): void {
    const limit = vscode.workspace
      .getConfiguration('editor', document)
      .get<number>(EDITOR_HINT_LENGTH_SETTING);

    // undefined on VS Code < 1.87; 0 means "never truncate".
    if (typeof limit !== 'number' || limit <= 0) {
      return;
    }

    const perLine = new Map<number, number>();
    for (const hint of hints) {
      if (typeof hint.label !== 'string') {
        continue;
      }
      const total = (perLine.get(hint.position.line) ?? 0) + hint.label.length;
      if (total > limit) {
        this.onHintsTruncated(limit);
        return;
      }
      perLine.set(hint.position.line, total);
    }
  }

  /** Lines containing a cursor in any visible editor for this document. */
  private activeCursorLines(document: vscode.TextDocument): Set<number> {
    const lines = new Set<number>();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== document.uri.toString()) {
        continue;
      }
      for (const selection of editor.selections) {
        for (let line = selection.start.line; line <= selection.end.line; line++) {
          lines.add(line);
        }
      }
    }
    return lines;
  }
}

/** Warn when a value row has a different item count than the column list. */
function computeDiagnostics(
  document: vscode.TextDocument,
  statements: InsertStatement[],
  settings: Settings,
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const statement of statements) {
    const expected = statement.columns.length;
    if (expected === 0) {
      continue;
    }
    for (let r = 0; r < statement.rows.length; r++) {
      const row = statement.rows[r];
      const actual = row.values.length;
      if (actual === expected) {
        continue;
      }

      const range = new vscode.Range(document.positionAt(row.open), document.positionAt(row.close));
      const missing = expected - actual;
      const detail =
        missing > 0
          ? `missing ${missing} value${missing === 1 ? '' : 's'} (first unfilled column: \`${statement.columns[actual].name}\`)`
          : `${-missing} extra value${missing === -1 ? '' : 's'}`;
      const diagnostic = new vscode.Diagnostic(
        range,
        `Row ${r + 1} of INSERT INTO ${statement.table || '?'} has ${actual} value${actual === 1 ? '' : 's'} but ${expected} columns are listed — ${detail}.`,
        settings.diagnosticSeverity,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = 'column-value-count-mismatch';
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

/** Raise (or restore) the editor's per-line inlay hint budget. */
async function setEditorHintLimit(value: number): Promise<void> {
  await vscode.workspace
    .getConfiguration('editor')
    .update(EDITOR_HINT_LENGTH_SETTING, value, vscode.ConfigurationTarget.Global);
}

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();
  const cache = new StatementCache();

  // Ask at most once per session, and never again if the user opts out.
  let truncationPromptPending = false;
  const handleTruncation = (limit: number): void => {
    if (truncationPromptPending || context.globalState.get<boolean>(SUPPRESS_TRUNCATION_PROMPT_KEY)) {
      return;
    }
    truncationPromptPending = true;
    void (async () => {
      const showAll = 'Show all hints';
      const notNow = 'Not now';
      const never = "Don't ask again";
      const choice = await vscode.window.showInformationMessage(
        `SQL Column Hints: VS Code hides inlay hints past ${limit} characters per line, so the last columns of wide INSERT rows are missing. Set "editor.inlayHints.maximumLength" to 0 to show them all? (This affects inlay hints from every extension.)`,
        showAll,
        notNow,
        never,
      );
      if (choice === showAll) {
        await setEditorHintLimit(0);
      } else if (choice === never) {
        await context.globalState.update(SUPPRESS_TRUNCATION_PROMPT_KEY, true);
      }
    })();
  };

  const provider = new ColumnHintsProvider(cache, settings, handleTruncation);
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);

  context.subscriptions.push(provider, diagnostics);

  const selector: vscode.DocumentSelector = settings.languages.map((language) => ({ language }));
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, provider));

  const isTracked = (document: vscode.TextDocument): boolean =>
    settings.languages.includes(document.languageId) && document.uri.scheme !== 'git';

  const refreshDiagnostics = (document: vscode.TextDocument): void => {
    if (!isTracked(document)) {
      return;
    }
    if (!settings.diagnosticsEnabled || !settings.enabled) {
      diagnostics.delete(document.uri);
      return;
    }
    if (document.getText().length > settings.maxFileSizeKB * 1024) {
      diagnostics.delete(document.uri);
      return;
    }
    diagnostics.set(document.uri, computeDiagnostics(document, cache.get(document), settings));
  };

  // Re-linting on every keystroke of a large dump file is wasteful; debounce.
  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleDiagnostics = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refreshDiagnostics(document);
      }, DEBOUNCE_MS),
    );
  };

  vscode.workspace.textDocuments.forEach(refreshDiagnostics);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleDiagnostics(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cache.forget(document);
      diagnostics.delete(document.uri);
      const timer = timers.get(document.uri.toString());
      if (timer) {
        clearTimeout(timer);
        timers.delete(document.uri.toString());
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      const previousLanguages = settings.languages.join(',');
      settings = readSettings();
      provider.updateSettings(settings);
      cache.clear();
      diagnostics.clear();
      vscode.workspace.textDocuments.forEach(refreshDiagnostics);
      if (previousLanguages !== settings.languages.join(',')) {
        void vscode.window.showInformationMessage(
          'SQL Column Hints: reload the window to apply the new language list.',
        );
      }
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      if (settings.skipHintsForRowsInsideSelection) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('sqlColumnHints.showAllHints', async () => {
      await setEditorHintLimit(0);
      await context.globalState.update(SUPPRESS_TRUNCATION_PROMPT_KEY, undefined);
      provider.refresh();
      void vscode.window.setStatusBarMessage(
        'SQL Column Hints: editor.inlayHints.maximumLength set to 0 — no more truncated hints',
        4000,
      );
    }),
    vscode.commands.registerCommand('sqlColumnHints.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const next = !cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(
        `SQL Column Hints ${next ? 'on' : 'off'}`,
        2000,
      );
    }),
  );
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
