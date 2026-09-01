/**
 * Plain-Node tests for the SQL parser (no vscode API involved).
 * Run: npm run compile && npm run test:parser
 */
const assert = require('assert');
const { parseSql, tokenize } = require('../out/sqlParser');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

/** Map a statement's row into [column, valueText] pairs. */
function pairs(sql, statement, rowIndex) {
  const row = statement.rows[rowIndex];
  return row.values.map((v, i) => [
    statement.columns[i] ? statement.columns[i].name : undefined,
    sql.slice(v.start, v.end),
  ]);
}

// ---------------------------------------------------------------------------
// The exact statement from the original request.
// ---------------------------------------------------------------------------
const walletSql = `INSERT INTO \`wallet\` (\`id\`, \`user_id\`, \`wallet_rule_id\`, \`currency_id\`, \`active_date\`, \`expire_date\`, \`status\`, \`name\`, \`first_name\`, \`last_name\`, \`phone_number\`, \`register_number\`, \`facebook_id\`, \`viber_id\`, \`source\`, \`picture_path\`, \`wallet_number\`, \`created_at\`, \`updated_at\`, \`flag\`, \`facebook_page_scope_id\`, \`invited_user\`, \`external_id\`, \`external_type\`) VALUES
('93', '1', '11', '1', NULL, NULL, '1', 'Lend', 'Илүү төлөлт СМЭ', 'ЛэндСМЭ ББСБ', '', '5039754', '', '', NULL, '', '1055100093', NOW(), NULL, '0', '', NULL, NULL, NULL),
('94', '1', '11', '1', NULL, NULL, '1', 'Lend', 'Эргэн төлөлт СМЭ', 'ЛэндСМЭ ББСБ', NULL, '5039754', NULL, NULL, NULL, NULL, '1055100094', NOW(), NULL, '0', NULL, NULL, NULL, NULL);`;

test('parses the wallet INSERT: one statement, 24 columns, 2 rows', () => {
  const [stmt] = parseSql(walletSql);
  assert.strictEqual(stmt.table, 'wallet');
  assert.strictEqual(stmt.columns.length, 24);
  assert.strictEqual(stmt.rows.length, 2);
  assert.strictEqual(stmt.columns[0].name, 'id');
  assert.strictEqual(stmt.columns[23].name, 'external_type');
});

test('every row has exactly one value per column', () => {
  const [stmt] = parseSql(walletSql);
  for (const row of stmt.rows) {
    assert.strictEqual(row.values.length, stmt.columns.length);
  }
});

test('values map to the right columns (including NOW() and Cyrillic text)', () => {
  const [stmt] = parseSql(walletSql);
  const row0 = pairs(walletSql, stmt, 0);
  assert.deepStrictEqual(row0[0], ['id', "'93'"]);
  assert.deepStrictEqual(row0[1], ['user_id', "'1'"]);
  assert.deepStrictEqual(row0[8], ['first_name', "'Илүү төлөлт СМЭ'"]);
  assert.deepStrictEqual(row0[17], ['created_at', 'NOW()']);
  assert.deepStrictEqual(row0[23], ['external_type', 'NULL']);

  const row1 = pairs(walletSql, stmt, 1);
  assert.deepStrictEqual(row1[0], ['id', "'94'"]);
  assert.deepStrictEqual(row1[16], ['wallet_number', "'1055100094'"]);
});

// ---------------------------------------------------------------------------
// Lexer edge cases
// ---------------------------------------------------------------------------
test('string literals: escaped quotes do not end the literal', () => {
  const sql = "INSERT INTO t (a, b) VALUES ('it''s', 'back\\'slash');";
  const [stmt] = parseSql(sql);
  const p = pairs(sql, stmt, 0);
  assert.deepStrictEqual(p[0], ['a', "'it''s'"]);
  assert.deepStrictEqual(p[1], ['b', "'back\\'slash'"]);
});

test('commas and parens inside strings and functions are ignored', () => {
  const sql =
    "INSERT INTO t (a, b, c) VALUES ('x, y)', CONCAT('p', ',', '(q)'), IF(1 > 0, 'yes', 'no'));";
  const [stmt] = parseSql(sql);
  const p = pairs(sql, stmt, 0);
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(p[0], ['a', "'x, y)'"]);
  assert.deepStrictEqual(p[1], ['b', "CONCAT('p', ',', '(q)')"]);
  assert.deepStrictEqual(p[2], ['c', "IF(1 > 0, 'yes', 'no')"]);
});

test('comments are skipped, including a comment between VALUES and the row', () => {
  const sql = `-- header comment with INSERT INTO fake (x) VALUES (1)
/* block, also fake: VALUES (2) */
INSERT INTO t (a, b) /* mid */ VALUES -- trailing
  (1, 2); # done`;
  const statements = parseSql(sql);
  assert.strictEqual(statements.length, 1);
  assert.strictEqual(statements[0].rows.length, 1);
  assert.deepStrictEqual(pairs(sql, statements[0], 0), [
    ['a', '1'],
    ['b', '2'],
  ]);
});

test('unterminated string does not hang or spill into the next statement', () => {
  const sql = "INSERT INTO t (a) VALUES ('oops";
  const statements = parseSql(sql);
  // Row never closes, so there is nothing to annotate - but we must not throw.
  assert.strictEqual(statements.length, 1);
  assert.strictEqual(statements[0].rows.length, 0);
});

// ---------------------------------------------------------------------------
// Dialect / shape variations
// ---------------------------------------------------------------------------
test('quoting styles: backticks, double quotes, brackets, bare', () => {
  const sql = 'INSERT INTO "schema"."tbl" ("a", [b], `c`, d) VALUES (1, 2, 3, 4);';
  const [stmt] = parseSql(sql);
  assert.strictEqual(stmt.table, 'tbl');
  assert.deepStrictEqual(
    stmt.columns.map((c) => c.name),
    ['a', 'b', 'c', 'd'],
  );
});

test('INSERT IGNORE / REPLACE INTO / INSERT OR REPLACE are recognised', () => {
  for (const head of ['INSERT IGNORE INTO', 'REPLACE INTO', 'INSERT OR REPLACE INTO']) {
    const sql = `${head} t (a, b) VALUES (1, 2);`;
    const [stmt] = parseSql(sql);
    assert.strictEqual(stmt.rows.length, 1, head);
    assert.strictEqual(stmt.columns.length, 2, head);
  }
});

test('ON DUPLICATE KEY UPDATE tail is not treated as a value row', () => {
  const sql =
    'INSERT INTO t (a, b) VALUES (1, 2), (3, 4) ON DUPLICATE KEY UPDATE b = VALUES(b);';
  const [stmt] = parseSql(sql);
  assert.strictEqual(stmt.rows.length, 2);
});

test('INSERT ... SELECT and INSERT ... SET produce no rows', () => {
  assert.strictEqual(parseSql('INSERT INTO t (a, b) SELECT x, y FROM u;')[0].rows.length, 0);
  assert.strictEqual(parseSql("INSERT INTO t SET a = 1, b = 'x';")[0].rows.length, 0);
});

test('INSERT without a column list yields no columns (nothing to label)', () => {
  const [stmt] = parseSql("INSERT INTO t VALUES (1, 'x');");
  assert.strictEqual(stmt.columns.length, 0);
  assert.strictEqual(stmt.rows.length, 1);
});

test('multiple statements in one file are all found', () => {
  const sql = `INSERT INTO a (x) VALUES (1);
INSERT INTO b (y, z) VALUES (2, 3), (4, 5);`;
  const statements = parseSql(sql);
  assert.strictEqual(statements.length, 2);
  assert.strictEqual(statements[0].table, 'a');
  assert.strictEqual(statements[1].rows.length, 2);
});

// ---------------------------------------------------------------------------
// Count-mismatch detection (what the diagnostics are built on)
// ---------------------------------------------------------------------------
test('detects a row with too few and a row with too many values', () => {
  const sql = 'INSERT INTO t (a, b, c) VALUES (1, 2), (1, 2, 3), (1, 2, 3, 4);';
  const [stmt] = parseSql(sql);
  assert.deepStrictEqual(
    stmt.rows.map((r) => r.values.length),
    [2, 3, 4],
  );
});

// ---------------------------------------------------------------------------
// Perf sanity: a 5k-row dump should parse well under a second.
// ---------------------------------------------------------------------------
test('parses a 5,000-row dump quickly', () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push(`('${i}', 'name ${i}', NULL, NOW())`);
  }
  const sql = `INSERT INTO big (id, name, note, created_at) VALUES\n${rows.join(',\n')};`;
  const started = Date.now();
  const [stmt] = parseSql(sql);
  const elapsed = Date.now() - started;
  assert.strictEqual(stmt.rows.length, 5000);
  assert.ok(elapsed < 1500, `parsing took ${elapsed}ms`);
  console.log(`      (${sql.length} chars in ${elapsed}ms, ${tokenize(sql).length} tokens)`);
});

console.log(`\n${passed} test(s) passed`);
