/**
 * Dependency-free SQL lexer + INSERT-statement parser.
 *
 * Kept completely free of the `vscode` API so it can be unit-tested with plain
 * Node (see test/parser.test.js) and reused from any host.
 *
 * All positions are absolute character offsets into the source string, which is
 * what `TextDocument.positionAt()` consumes.
 */

export const enum TokenKind {
  /** Bare word: keyword, identifier, or number. */
  Word = 'word',
  /** Quoted identifier: `col`, "col", [col]. */
  QuotedIdent = 'quotedIdent',
  /** String literal: 'text'. */
  String = 'string',
  /** Single punctuation character: ( ) , ; . = etc. */
  Punct = 'punct',
}

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token, quotes included. */
  text: string;
  /** Uppercased text, for keyword comparison (Word tokens only, else ''). */
  upper: string;
  start: number;
  end: number;
}

export interface ColumnRef {
  /** Column name with any quoting stripped. */
  name: string;
  start: number;
  end: number;
}

export interface ValueRef {
  /** Offset of the first token of the expression (where the hint is anchored). */
  start: number;
  /** Offset just past the last token of the expression. */
  end: number;
}

export interface ValueRow {
  /** Offset of the row's opening parenthesis. */
  open: number;
  /** Offset just past the row's closing parenthesis. */
  close: number;
  values: ValueRef[];
}

export interface InsertStatement {
  /** Table name as written (quoting stripped), or '' when unparseable. */
  table: string;
  /** Empty when the statement has no explicit column list. */
  columns: ColumnRef[];
  rows: ValueRow[];
}

const WORD_START = /[A-Za-z_$\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DIGIT = /[0-9]/;

/** Characters that open a quoted identifier, mapped to their closing char. */
const IDENT_QUOTES: Record<string, string> = { '`': '`', '"': '"', '[': ']' };

/**
 * Turn SQL text into a flat token stream, discarding whitespace and comments.
 *
 * The lexer is deliberately dialect-tolerant: it accepts MySQL backticks and
 * `#` comments, T-SQL brackets, ANSI double-quoted identifiers, dollar-quoted
 * Postgres bodies, and both `''` and `\'` escapes inside string literals.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const len = text.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number): void => {
    const raw = text.slice(start, end);
    tokens.push({
      kind,
      text: raw,
      upper: kind === TokenKind.Word ? raw.toUpperCase() : '',
      start,
      end,
    });
  };

  while (i < len) {
    const ch = text[i];

    // --- whitespace ---
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }

    // --- line comments: -- ... and # ... ---
    if ((ch === '-' && text[i + 1] === '-') || ch === '#') {
      while (i < len && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    // --- block comments: /* ... */ (not nested in standard SQL) ---
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i = Math.min(i + 2, len);
      continue;
    }

    // --- string literals ---
    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (text[i] === '\\' && i + 1 < len) {
          i += 2; // MySQL-style backslash escape
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2; // doubled quote escape
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push(TokenKind.String, start, i);
      continue;
    }

    // --- Postgres dollar-quoted string: $tag$ ... $tag$ ---
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const start = i;
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? len : close + tag.length;
        push(TokenKind.String, start, i);
        continue;
      }
    }

    // --- quoted identifiers: `col`  "col"  [col] ---
    const closer = IDENT_QUOTES[ch];
    if (closer) {
      const start = i;
      i++;
      while (i < len) {
        if (text[i] === closer) {
          // `` and "" are escaped quotes inside the identifier
          if (closer !== ']' && text[i + 1] === closer) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push(TokenKind.QuotedIdent, start, i);
      continue;
    }

    // --- numbers (incl. .5, 1e-9, 0xFF) ---
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(text[i + 1] ?? ''))) {
      const start = i;
      i++;
      while (i < len && /[0-9A-Fa-fxX._]/.test(text[i])) {
        i++;
      }
      if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < len && DIGIT.test(text[i])) {
          i++;
        }
      }
      push(TokenKind.Word, start, i);
      continue;
    }

    // --- bare words ---
    if (WORD_START.test(ch)) {
      const start = i;
      i++;
      while (i < len && WORD_PART.test(text[i])) {
        i++;
      }
      push(TokenKind.Word, start, i);
      continue;
    }

    // --- everything else: single-character punctuation ---
    push(TokenKind.Punct, i, i + 1);
    i++;
  }

  return tokens;
}

/** Strip surrounding backticks / double quotes / brackets from an identifier. */
export function unquoteIdent(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
      return raw.slice(1, -1).replace(new RegExp(first + first, 'g'), first);
    }
    if (first === '[' && last === ']') {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/** Words allowed between INSERT/REPLACE and the table name across dialects. */
const INSERT_MODIFIERS = new Set([
  'LOW_PRIORITY',
  'DELAYED',
  'HIGH_PRIORITY',
  'IGNORE',
  'INTO',
  'OR',
  'ROLLBACK',
  'ABORT',
  'FAIL',
  'REPLACE',
  'OVERWRITE',
  'TABLE',
]);

/** Words that terminate the table-name scan. */
const TABLE_NAME_STOPPERS = new Set([
  'VALUES',
  'VALUE',
  'SET',
  'SELECT',
  'WITH',
  'DEFAULT',
  'PARTITION',
  'AS',
  'ON',
]);

const isPunct = (t: Token | undefined, c: string): boolean =>
  t !== undefined && t.kind === TokenKind.Punct && t.text === c;

/**
 * Find every `INSERT ... (cols) VALUES (...), (...)` statement in the token
 * stream. Statements without an explicit column list, or using
 * `INSERT ... SET` / `INSERT ... SELECT`, yield no rows (nothing to label).
 */
export function parseInserts(tokens: Token[]): InsertStatement[] {
  const statements: InsertStatement[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== TokenKind.Word || (t.upper !== 'INSERT' && t.upper !== 'REPLACE')) {
      continue;
    }

    let j = i + 1;

    // 1. Skip dialect modifiers (IGNORE, INTO, OR REPLACE, ...).
    while (j < tokens.length && tokens[j].kind === TokenKind.Word && INSERT_MODIFIERS.has(tokens[j].upper)) {
      j++;
    }

    // 2. Table name: identifiers and dots up to '(' or a stopper keyword.
    const tableParts: string[] = [];
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.kind === TokenKind.QuotedIdent) {
        tableParts.push(unquoteIdent(tok.text));
        j++;
      } else if (tok.kind === TokenKind.Word && !TABLE_NAME_STOPPERS.has(tok.upper)) {
        tableParts.push(tok.text);
        j++;
      } else if (isPunct(tok, '.')) {
        j++;
      } else {
        break;
      }
    }
    const table = tableParts.length ? tableParts[tableParts.length - 1] : '';

    // 3. Optional column list.
    const columns: ColumnRef[] = [];
    if (isPunct(tokens[j], '(')) {
      const listResult = parseColumnList(tokens, j);
      if (!listResult) {
        i = j;
        continue;
      }
      columns.push(...listResult.columns);
      j = listResult.next;
    }

    // 4. Find VALUES / VALUE, bailing out on SELECT / SET / statement end.
    let sawValues = false;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.kind === TokenKind.Word && (tok.upper === 'VALUES' || tok.upper === 'VALUE')) {
        sawValues = true;
        j++;
        break;
      }
      if (tok.kind === TokenKind.Word && (tok.upper === 'SELECT' || tok.upper === 'SET' || tok.upper === 'WITH')) {
        break;
      }
      if (isPunct(tok, ';')) {
        break;
      }
      j++;
    }

    if (!sawValues) {
      // INSERT ... SELECT / INSERT ... SET: recorded, but there is nothing to label.
      statements.push({ table, columns, rows: [] });
      i = j;
      continue;
    }

    // 5. Value rows: ( expr, expr, ... ) [, ( ... )]*
    const rows: ValueRow[] = [];
    while (isPunct(tokens[j], '(')) {
      const row = parseValueRow(tokens, j);
      if (!row) {
        break;
      }
      rows.push(row.row);
      j = row.next;
      if (isPunct(tokens[j], ',')) {
        j++;
        continue;
      }
      break;
    }

    statements.push({ table, columns, rows });
    i = j - 1;
  }

  return statements;
}

/** Parse `( col, col, ... )` starting at the open paren. */
function parseColumnList(tokens: Token[], openIndex: number): { columns: ColumnRef[]; next: number } | undefined {
  const columns: ColumnRef[] = [];
  let k = openIndex + 1;
  let current: Token | undefined;

  while (k < tokens.length) {
    const tok = tokens[k];

    if (isPunct(tok, ')')) {
      if (current) {
        columns.push({ name: unquoteIdent(current.text), start: current.start, end: current.end });
      }
      return { columns, next: k + 1 };
    }

    if (isPunct(tok, ',')) {
      if (current) {
        columns.push({ name: unquoteIdent(current.text), start: current.start, end: current.end });
        current = undefined;
      }
      k++;
      continue;
    }

    if (isPunct(tok, '(')) {
      // Not a column list after all (e.g. an expression) - give up cleanly.
      return undefined;
    }

    if (tok.kind === TokenKind.Word || tok.kind === TokenKind.QuotedIdent) {
      // For `db`.`col` the last identifier wins.
      current = tok;
      k++;
      continue;
    }

    if (isPunct(tok, '.')) {
      k++;
      continue;
    }

    // Anything else (string literal, operator, ';') means this isn't a column list.
    return undefined;
  }

  return undefined;
}

/** Parse one `( expr, expr, ... )` value row starting at the open paren. */
function parseValueRow(tokens: Token[], openIndex: number): { row: ValueRow; next: number } | undefined {
  const values: ValueRef[] = [];
  let depth = 0;
  let exprStart: Token | undefined;
  let exprEnd: Token | undefined;

  const flush = (): void => {
    if (exprStart && exprEnd) {
      values.push({ start: exprStart.start, end: exprEnd.end });
    }
    exprStart = undefined;
    exprEnd = undefined;
  };

  for (let k = openIndex; k < tokens.length; k++) {
    const tok = tokens[k];

    if (isPunct(tok, '(')) {
      depth++;
      if (depth > 1) {
        if (!exprStart) {
          exprStart = tok;
        }
        exprEnd = tok;
      }
      continue;
    }

    if (isPunct(tok, ')')) {
      depth--;
      if (depth === 0) {
        flush();
        return { row: { open: tokens[openIndex].start, close: tok.end, values }, next: k + 1 };
      }
      exprEnd = tok;
      continue;
    }

    if (depth === 1 && isPunct(tok, ',')) {
      flush();
      continue;
    }

    // A stray semicolon means the statement is malformed / still being typed.
    if (isPunct(tok, ';')) {
      return undefined;
    }

    if (!exprStart) {
      exprStart = tok;
    }
    exprEnd = tok;
  }

  return undefined;
}

/** Convenience wrapper: text in, statements out. */
export function parseSql(text: string): InsertStatement[] {
  return parseInserts(tokenize(text));
}
