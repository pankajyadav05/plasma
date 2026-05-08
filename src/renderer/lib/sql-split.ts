/**
 * Split a SQL string into statements, respecting Postgres quoting and
 * comments. Used by the multi-statement runner so a tab containing
 * `INSERT …; UPDATE …; SELECT …` runs each statement in order, stops
 * on the first error, and reports per-statement progress.
 *
 * Handles:
 *   - Single quotes (`'...'`) with `''` escapes
 *   - Double-quoted identifiers (`"..."`) with `""` escapes
 *   - Dollar-quoted strings (`$$...$$`, `$tag$...$tag$`) — required for
 *     function bodies and PL/pgSQL DO blocks
 *   - Line comments (`-- …\n`)
 *   - Block comments (`/* … *\/`) — Postgres allows these to nest
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

    // Line comment — runs to end of line.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? N : nl + 1;
      continue;
    }

    // Block comment — Postgres allows nesting, track depth.
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

    // Single-quoted string (with '' escapes).
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

    // Double-quoted identifier (with "" escapes).
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

    // Dollar-quoted string. The opening tag is `$<ident?>$`. We capture
    // the tag (possibly empty) and scan for the matching closer.
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const closer = tagMatch[0];
        const after = i + closer.length;
        const end = sql.indexOf(closer, after);
        if (end === -1) {
          // Unterminated — treat the rest as part of the current statement.
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
