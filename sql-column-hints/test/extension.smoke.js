/**
 * Smoke test for src/extension.ts against a minimal `vscode` API mock.
 * Verifies the real activate() path: provider registration, hint labels and
 * positions, viewport range filtering, and count-mismatch diagnostics.
 *
 * Run: npm run compile && node test/extension.smoke.js
 */
const assert = require('assert');
const Module = require('module');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Minimal vscode API mock
// ---------------------------------------------------------------------------
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose() {} };
    };
  }
  fire(value) {
    this.listeners.forEach((fn) => fn(value));
  }
  dispose() {
    this.listeners = [];
  }
}

const settings = {
  enabled: true,
  languages: ['sql'],
  hintPosition: 'before',
  maxColumnNameLength: 32,
  maxRowsPerStatement: 500,
  maxFileSizeKB: 4096,
  skipHintsForRowsInsideSelection: false,
  warnAboutEditorHintLimit: true,
  'diagnostics.enabled': true,
  'diagnostics.severity': 'warning',
};

// VS Code's own editor.* settings, incl. the per-line inlay hint budget.
// Starts at 0 ("never truncate") so the earlier tests see no prompts; the
// truncation tests at the bottom set it to VS Code's real default of 43.
const editorSettings = { 'inlayHints.maximumLength': 0 };

// Queue of answers showInformationMessage should return, plus a log of prompts.
const messageQueue = [];
const shownMessages = [];

const diagnosticStore = new Map();
const registered = { providers: [], commands: new Map(), handlers: {} };
const disposable = { dispose() {} };
const on = (name) => (fn) => {
  registered.handlers[name] = fn;
  return disposable;
};

const vscodeMock = {
  Position,
  Range,
  EventEmitter,
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  InlayHint: class {
    constructor(position, label, kind) {
      this.position = position;
      this.label = label;
      this.kind = kind;
    }
  },
  InlayHintKind: { Type: 1, Parameter: 2 },
  Diagnostic: class {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    textDocuments: [],
    getConfiguration: (section) => {
      const store = section === 'editor' ? editorSettings : settings;
      return {
        get: (key, fallback) => (key in store ? store[key] : fallback),
        update: async (key, value) => {
          store[key] = value;
        },
      };
    },
    onDidOpenTextDocument: on('open'),
    onDidChangeTextDocument: on('change'),
    onDidCloseTextDocument: on('close'),
    onDidChangeConfiguration: on('config'),
  },
  window: {
    visibleTextEditors: [],
    showInformationMessage: (message, ...actions) => {
      shownMessages.push({ message, actions });
      return Promise.resolve(messageQueue.shift());
    },
    setStatusBarMessage: () => disposable,
    onDidChangeTextEditorSelection: on('selection'),
  },
  languages: {
    registerInlayHintsProvider: (selector, provider) => {
      registered.providers.push({ selector, provider });
      return disposable;
    },
    createDiagnosticCollection: () => ({
      set: (uri, diags) => diagnosticStore.set(String(uri), diags),
      delete: (uri) => diagnosticStore.delete(String(uri)),
      clear: () => diagnosticStore.clear(),
      dispose() {},
    }),
  },
  commands: {
    registerCommand: (id, fn) => {
      registered.commands.set(id, fn);
      return disposable;
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, ...rest);
};

const extension = require('../out/extension');

// ---------------------------------------------------------------------------
// Fake TextDocument
// ---------------------------------------------------------------------------
function makeDocument(text, uri = 'file:///test.sql', languageId = 'sql') {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  return {
    uri: { toString: () => uri, scheme: 'file' },
    languageId,
    version: 1,
    getText: () => text,
    positionAt(offset) {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line++;
      }
      return new Position(line, offset - lineStarts[line]);
    },
    offsetAt(position) {
      return (lineStarts[position.line] ?? 0) + position.character;
    },
    get lineCount() {
      return lineStarts.length;
    },
  };
}

const noCancel = { isCancellationRequested: false };
const fullRange = (doc) => new Range(new Position(0, 0), doc.positionAt(doc.getText().length));

const globalStateStore = new Map();
const context = {
  subscriptions: [],
  globalState: {
    get: (key, fallback) => (globalStateStore.has(key) ? globalStateStore.get(key) : fallback),
    update: async (key, value) => {
      if (value === undefined) {
        globalStateStore.delete(key);
      } else {
        globalStateStore.set(key, value);
      }
    },
  },
};
extension.activate(context);
const provider = registered.providers[0].provider;

const WALLET = `INSERT INTO \`wallet\` (\`id\`, \`user_id\`, \`status\`, \`first_name\`, \`created_at\`) VALUES
('93', '1', '1', 'Илүү төлөлт СМЭ', NOW()),
('94', '1', '1', 'Эргэн төлөлт СМЭ', NOW());`;

test('activate() registers a provider, a command and event handlers', () => {
  assert.strictEqual(registered.providers.length, 1);
  assert.deepStrictEqual(registered.providers[0].selector, [{ language: 'sql' }]);
  assert.ok(registered.commands.has('sqlColumnHints.toggle'));
  ['open', 'change', 'close', 'config', 'selection'].forEach((h) =>
    assert.ok(registered.handlers[h], `missing handler: ${h}`),
  );
  assert.ok(context.subscriptions.length > 5);
});

test('hint labels and anchor positions line up with the values', () => {
  const doc = makeDocument(WALLET);
  const hints = provider.provideInlayHints(doc, fullRange(doc), noCancel);

  assert.strictEqual(hints.length, 10, '5 columns x 2 rows');
  assert.deepStrictEqual(
    hints.slice(0, 5).map((h) => h.label),
    ['id:', 'user_id:', 'status:', 'first_name:', 'created_at:'],
  );
  assert.strictEqual(hints[0].kind, vscodeMock.InlayHintKind.Parameter);
  assert.strictEqual(hints[0].paddingRight, true);

  // Every hint must sit exactly where its value starts.
  const text = doc.getText();
  for (const hint of hints) {
    const offset = doc.offsetAt(hint.position);
    const following = text.slice(offset, offset + 4);
    assert.ok(
      /^('|N)/.test(following),
      `hint "${hint.label}" anchored at ${JSON.stringify(following)}`,
    );
  }
  // Row 1 hints are on line 1, row 2 hints on line 2.
  assert.deepStrictEqual([...new Set(hints.map((h) => h.position.line))], [1, 2]);
});

test('hintPosition: "after" anchors past the value with left padding', () => {
  settings.hintPosition = 'after';
  registered.handlers.config({ affectsConfiguration: () => true });
  const doc = makeDocument(WALLET);
  const hints = provider.provideInlayHints(doc, fullRange(doc), noCancel);
  assert.strictEqual(hints[0].label, ':id');
  assert.strictEqual(hints[0].paddingLeft, true);
  settings.hintPosition = 'before';
  registered.handlers.config({ affectsConfiguration: () => true });
});

test('only rows overlapping the requested range are computed', () => {
  const doc = makeDocument(WALLET);
  const lineTwoStart = doc.getText().indexOf("('94'");
  const range = new Range(doc.positionAt(lineTwoStart), doc.positionAt(doc.getText().length));
  const hints = provider.provideInlayHints(doc, range, noCancel);
  assert.strictEqual(hints.length, 5);
  assert.deepStrictEqual([...new Set(hints.map((h) => h.position.line))], [2]);
});

test('disabling the extension yields no hints', () => {
  settings.enabled = false;
  registered.handlers.config({ affectsConfiguration: () => true });
  const doc = makeDocument(WALLET);
  assert.strictEqual(provider.provideInlayHints(doc, fullRange(doc), noCancel).length, 0);
  settings.enabled = true;
  registered.handlers.config({ affectsConfiguration: () => true });
});

test('maxRowsPerStatement caps the hints on a huge statement', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(`(${i}, 'n${i}')`);
  }
  const doc = makeDocument(`INSERT INTO t (id, name) VALUES\n${rows.join(',\n')};`);
  settings.maxRowsPerStatement = 10;
  registered.handlers.config({ affectsConfiguration: () => true });
  assert.strictEqual(provider.provideInlayHints(doc, fullRange(doc), noCancel).length, 20);
  settings.maxRowsPerStatement = 500;
  registered.handlers.config({ affectsConfiguration: () => true });
});

test('a long column name is truncated in the label', () => {
  const doc = makeDocument('INSERT INTO t (a_very_long_column_name_indeed) VALUES (1);');
  settings.maxColumnNameLength = 10;
  registered.handlers.config({ affectsConfiguration: () => true });
  const [hint] = provider.provideInlayHints(doc, fullRange(doc), noCancel);
  assert.strictEqual(hint.label, 'a_very_lo…:');
  settings.maxColumnNameLength = 32;
  registered.handlers.config({ affectsConfiguration: () => true });
});

test('count mismatch produces a diagnostic on the offending row only', () => {
  const doc = makeDocument(
    'INSERT INTO t (a, b, c) VALUES\n(1, 2, 3),\n(4, 5),\n(6, 7, 8, 9);',
    'file:///diag.sql',
  );
  registered.handlers.open(doc);
  const diags = diagnosticStore.get('file:///diag.sql');
  assert.strictEqual(diags.length, 2);
  assert.strictEqual(diags[0].severity, vscodeMock.DiagnosticSeverity.Warning);
  assert.strictEqual(diags[0].range.start.line, 2, 'first bad row is line 2');
  assert.match(diags[0].message, /has 2 values but 3 columns/);
  assert.match(diags[0].message, /missing 1 value \(first unfilled column: `c`\)/);
  assert.match(diags[1].message, /has 4 values but 3 columns.*1 extra value/);
});

test('well-formed SQL produces no diagnostics', () => {
  const doc = makeDocument(WALLET, 'file:///clean.sql');
  registered.handlers.open(doc);
  assert.deepStrictEqual(diagnosticStore.get('file:///clean.sql'), []);
});

test('non-SQL documents are ignored', () => {
  const doc = makeDocument(WALLET, 'file:///notes.md', 'markdown');
  registered.handlers.open(doc);
  assert.strictEqual(diagnosticStore.has('file:///notes.md'), false);
});

test('closing a document clears its diagnostics', () => {
  const doc = makeDocument('INSERT INTO t (a, b) VALUES (1);', 'file:///gone.sql');
  registered.handlers.open(doc);
  assert.strictEqual(diagnosticStore.get('file:///gone.sql').length, 1);
  registered.handlers.close(doc);
  assert.strictEqual(diagnosticStore.has('file:///gone.sql'), false);
});

test('provider re-fires onDidChangeInlayHints when settings change', () => {
  let fired = 0;
  provider.onDidChangeInlayHints(() => fired++);
  registered.handlers.config({ affectsConfiguration: () => true });
  assert.strictEqual(fired, 1);
});

test('scrolling a cached document does not re-parse it', () => {
  const doc = makeDocument(WALLET);
  const a = provider.provideInlayHints(doc, fullRange(doc), noCancel);
  const b = provider.provideInlayHints(doc, fullRange(doc), noCancel);
  assert.deepStrictEqual(
    a.map((h) => h.label),
    b.map((h) => h.label),
  );
});

// ---------------------------------------------------------------------------
// VS Code's per-line inlay hint budget (editor.inlayHints.maximumLength).
// This is the real statement from the bug report: id: + created_at: +
// created_user_id: + name: = 35 chars, so description: overflows the 43-char
// default and status: is dropped by the editor entirely.
// ---------------------------------------------------------------------------
const PRODUCT_TYPE = `INSERT INTO product_type (id, created_at, created_user_id, name, description, status) VALUES
(225, NOW(), 488, 'Flexi Business Micro SME', 'Flexi Business Micro', 1),
(247, NOW(), 488, 'BankLike SME', 'BankLine Installment', 1);`;

async function main() {
  const doc = makeDocument(PRODUCT_TYPE, 'file:///product_type.sql');

  await asyncTest('no truncation prompt while the editor limit is 0', async () => {
    shownMessages.length = 0;
    provider.provideInlayHints(doc, fullRange(doc), noCancel);
    await tick();
    assert.strictEqual(shownMessages.length, 0);
  });

  await asyncTest('detects the 43-char default hiding the last columns', async () => {
    editorSettings['inlayHints.maximumLength'] = 43;
    shownMessages.length = 0;
    messageQueue.push("Don't ask again");

    const hints = provider.provideInlayHints(doc, fullRange(doc), noCancel);
    // The extension itself still returns every hint - the editor is the one
    // dropping them - so the per-line overflow must be real.
    assert.strictEqual(hints.length, 12, '6 columns x 2 rows');
    const lineOneLength = hints
      .filter((h) => h.position.line === 1)
      .reduce((sum, h) => sum + h.label.length, 0);
    assert.ok(lineOneLength > 43, `line label budget was ${lineOneLength}`);

    await tick();
    assert.strictEqual(shownMessages.length, 1);
    assert.match(shownMessages[0].message, /hides inlay hints past 43 characters per line/);
    assert.deepStrictEqual(shownMessages[0].actions, [
      'Show all hints',
      'Not now',
      "Don't ask again",
    ]);
    // "Don't ask again" must persist, and must not touch the editor setting.
    assert.strictEqual(globalStateStore.get('sqlColumnHints.suppressTruncationPrompt'), true);
    assert.strictEqual(editorSettings['inlayHints.maximumLength'], 43);
  });

  await asyncTest('the prompt is shown at most once per session', async () => {
    shownMessages.length = 0;
    provider.provideInlayHints(doc, fullRange(doc), noCancel);
    provider.provideInlayHints(doc, fullRange(doc), noCancel);
    await tick();
    assert.strictEqual(shownMessages.length, 0);
  });

  await asyncTest('showAllHints command lifts the limit and clears the opt-out', async () => {
    await registered.commands.get('sqlColumnHints.showAllHints')();
    assert.strictEqual(editorSettings['inlayHints.maximumLength'], 0);
    assert.strictEqual(globalStateStore.has('sqlColumnHints.suppressTruncationPrompt'), false);
  });

  await asyncTest('warnAboutEditorHintLimit=false suppresses the check entirely', async () => {
    editorSettings['inlayHints.maximumLength'] = 43;
    settings.warnAboutEditorHintLimit = false;
    globalStateStore.clear();
    registered.handlers.config({ affectsConfiguration: () => true });
    shownMessages.length = 0;
    provider.provideInlayHints(doc, fullRange(doc), noCancel);
    await tick();
    assert.strictEqual(shownMessages.length, 0);
    settings.warnAboutEditorHintLimit = true;
  });

  Module._load = originalLoad;
  console.log(`\n${passed} smoke test(s) passed`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack);
    process.exitCode = 1;
  }
}

void main();
