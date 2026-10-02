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

export function getCaptures(): Record<CaptureKey, Capture> {
  const dir = path.join(process.cwd(), 'public', 'product', 'v2');
  const sizes = readSizes(dir);
  const out = {} as Record<CaptureKey, Capture>;
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
  return out;
}

export type Captures = Record<CaptureKey, Capture>;
