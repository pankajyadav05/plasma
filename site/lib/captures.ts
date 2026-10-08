import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single source of truth for every product image on the page.
 *
 * Each key maps to a real capture in /public/product/v2/ (written by the
 * capture pipeline). If a v2 file is not on disk yet, the key falls back to
 * the older illustrative capture, so the site always builds. Resolution
 * happens at build time on the server; swapping in new captures needs no
 * code change, only the files (and, optionally, captures.json for sizes).
 */
export type CaptureKey =
  | 'pg-workbench'
  | 'pg-editor'
  | 'pg-structure'
  | 'pg-er'
  | 'pg-import'
  | 'pg-roles'
  | 'pg-search'
  | 'pg-split'
  | 'pg-explain'
  | 'guard-confirm'
  | 'palette'
  | 'redis'
  | 'opensearch';

/**
 * Captures that only exist as real v2 files. There is no older illustrative
 * stand-in for them: until the file is on disk the key is simply absent and
 * the page renders without that image.
 */
export type OptionalCaptureKey =
  | 'ai-agent'
  | 'ai-memory'
  | 'mcp-proposal'
  | 'mcp-settings'
  | 'compare'
  | 'conflict'
  | 'notebook'
  | 'diagnosis'
  | 'recovery';

export type AnyCaptureKey = CaptureKey | OptionalCaptureKey;

export interface Capture {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** true when the real v2 capture is being served */
  real: boolean;
}

interface Fallback {
  file: string;
  width: number;
  height: number;
}

const PG: Fallback = { file: 'postgres.webp', width: 1800, height: 1125 };

/** v2 file name -> fallback used until that file exists. */
const FALLBACKS: Record<CaptureKey, Fallback> = {
  'pg-workbench': PG,
  'pg-editor': PG,
  'pg-structure': PG,
  'pg-er': PG,
  'pg-import': PG,
  'pg-roles': PG,
  'pg-search': PG,
  'pg-split': PG,
  'pg-explain': { file: 'explain.webp', width: 1120, height: 593 },
  'guard-confirm': PG,
  palette: PG,
  redis: { file: 'redis.webp', width: 1800, height: 1125 },
  opensearch: { file: 'opensearch.webp', width: 1800, height: 1125 },
};

const ALT: Record<CaptureKey, string> = {
  'pg-workbench':
    'Plasma showing a Postgres table: the connection capsule at the top left, a schema sidebar listing tables, a data grid with inline editing, and a details form for the selected row.',
  'pg-editor':
    'Plasma SQL editor with a multi-statement script and one result tab per statement, each with its row count and timing.',
  'pg-structure':
    'Plasma structure view with a staged column change and the Preview SQL panel showing the statement that will run.',
  'pg-er':
    'Plasma ER diagram of a schema, with tables as boxes joined by foreign-key lines.',
  'pg-import':
    'Plasma import dialog with a file preview and column mapping.',
  'pg-roles':
    'Plasma roles and privileges dialog listing users, memberships and table privileges.',
  'pg-search':
    'Plasma search in database, showing matching values grouped by table.',
  'pg-split':
    'Plasma with two tabs open side by side in split panes.',
  'pg-explain':
    'Plasma EXPLAIN view showing a query plan as a tree with costs and timings.',
  'guard-confirm':
    'Plasma confirmation dialog asking before a DROP statement runs.',
  palette: 'Plasma command palette open over the workbench.',
  redis:
    'Plasma Redis workspace: a key browser on the left and a hash open in a typed editor.',
  opensearch:
    'Plasma OpenSearch workspace showing indices on the left and documents in the main pane.',
};

const OPTIONAL_ALT: Record<OptionalCaptureKey, string> = {
  'ai-agent':
    'Plasma assistant in the right sidebar: the agent proposes a query as an approval card with the statement and its buttons, and nothing runs until you click.',
  'ai-memory':
    'Plasma database memory: a short list of notes about one connection, each labelled with who wrote it.',
  'mcp-proposal':
    'Plasma asking for approval: a card titled Claude Code wants to change data, with the exact statement and a summary, waiting for you to approve or reject.',
  'mcp-settings':
    'Plasma settings for the MCP server: the on switch, the port, the setup snippet for each AI tool and the access level of each connection.',
  compare:
    'Plasma Result Compare: two result sets diffed by key, with added, removed and changed rows marked.',
  conflict:
    'Plasma dialog titled A row changed while you were editing, showing the value you loaded, the value on the server now and your value, with Keep mine and Take theirs.',
  notebook:
    'Plasma notebook: a document of SQL cells and Markdown notes, with the result of a cell under it.',
  diagnosis:
    'Plasma connection test listing each step in order, with the failing step marked and a plain-language explanation of what to try.',
  recovery:
    'Plasma after a crash: a notice naming how many tabs and unsaved edits were restored.',
};

type SizeMap = Record<string, { width: number; height: number }>;

/** Tolerant reader: accepts {files:{name:{width,height}}}, {name:{w,h}} or {name:[w,h]}. */
function readSizes(dir: string): SizeMap {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'captures.json'), 'utf8'));
    const table = raw && typeof raw === 'object' && raw.files ? raw.files : raw;
    const out: SizeMap = {};
    for (const [name, v] of Object.entries(table ?? {})) {
      const val = v as Record<string, unknown> | unknown[];
      let w: unknown;
      let h: unknown;
      if (Array.isArray(val)) [w, h] = val;
      else {
        w = val.width ?? val.w;
        h = val.height ?? val.h;
      }
      if (typeof w === 'number' && typeof h === 'number') out[name] = { width: w, height: h };
    }
    return out;
  } catch {
    return {};
  }
}

export function getCaptures(): Captures {
  const dir = path.join(process.cwd(), 'public', 'product', 'v2');
  const sizes = readSizes(dir);
  const out = {} as Captures;
  for (const key of Object.keys(FALLBACKS) as CaptureKey[]) {
    const file = `${key}.webp`;
    const fb = FALLBACKS[key];
    const exists = fs.existsSync(path.join(dir, file));
    if (exists) {
      const s = sizes[file] ?? { width: fb.width, height: fb.height };
      out[key] = { src: `/product/v2/${file}`, ...s, alt: ALT[key], real: true };
    } else {
      out[key] = {
        src: `/product/${fb.file}`,
        width: fb.width,
        height: fb.height,
        alt: ALT[key],
        real: false,
      };
    }
  }
  // Real-only captures: read the true size from v2/captures.json, skip when absent.
  for (const key of Object.keys(OPTIONAL_ALT) as OptionalCaptureKey[]) {
    const file = `${key}.webp`;
    if (!fs.existsSync(path.join(dir, file))) continue;
    const s = sizes[file] ?? { width: 2880, height: 1800 };
    out[key] = { src: `/product/v2/${file}`, ...s, alt: OPTIONAL_ALT[key], real: true };
  }
  return out;
}

export type Captures = Record<CaptureKey, Capture> & Partial<Record<OptionalCaptureKey, Capture>>;
