/**
 * Split a SQL string into statements, respecting Postgres quoting and
 * comments. Shared by the renderer multi-statement runner and the AI
 * read-only executor (which rejects anything other than a single
 * statement before the database ever sees it).
 *
 * Handles:
 *   - Single quotes (`'...'`) with `''` escapes
 *   - Double-quoted identifiers (`"..."`) with `""` escapes
 *   - Dollar-quoted strings (`$$...$$`, `$tag$...$tag$`)
 *   - Line comments (`-- …\n`)
 *   - Nested block comments (`/* … *\/`)
 *
 * Returns trimmed, non-empty statement strings (without trailing `;`).
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  const N = sql.length;

  while (i < N) {
    const c = sql[i];

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < N && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === "'") {
      i++;
      while (i < N) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === '"') {
      i++;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const closer = tagMatch[0];
        const after = i + closer.length;
        const end = sql.indexOf(closer, after);
        if (end === -1) {
          i = N;
        } else {
          i = end + closer.length;
        }
        continue;
      }
    }

    if (c === ';') {
      const piece = sql.slice(start, i).trim();
      if (piece.length > 0) out.push(piece);
      start = i + 1;
      i++;
      continue;
    }

    i++;
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** True when `sql` contains exactly one non-empty statement. */
export function isSingleSqlStatement(sql: string): boolean {
  return splitSqlStatements(sql).length === 1;
}
