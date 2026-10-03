import { cellToText } from '@/features/result-grid/cell-edit';
import { useSession } from '@/stores/session';
import {
  type ColumnMask,
  EMPTY_MASK_RULES,
  type MaskRules,
  type MaskStyle,
  SAMPLE_ROWS,
  maskValue,
  resolveMaskedColumns,
  withPlainColumn,
  withSensitiveColumn,
  withoutColumnRule,
} from '@shared/masking';
import type { ColumnMeta, QueryResult } from '@shared/protocol';
import { useCallback, useEffect, useMemo } from 'react';
import { isRevealed, revealKey, useReveal } from './reveal-store';

const NO_MASKS: ReadonlyMap<number, ColumnMask> = new Map();

export interface PresentationConfig {
  active: boolean;
  style: MaskStyle;
  rules: MaskRules;
  connectionId: string | null;
}

/** Current presentation settings, outside React (clipboard, exports). */
export function presentationConfig(): PresentationConfig {
  const s = useSession.getState();
  const id = s.activeConfig?.id ?? null;
  return {
    active: s.settings.presentationMode === true,
    style: s.settings.maskStyle ?? 'initial',
    rules: (id ? s.settings.maskRules?.[id] : undefined) ?? EMPTY_MASK_RULES,
    connectionId: id,
  };
}

/** Presentation settings as a hook. */
export function usePresentation(): PresentationConfig {
  const active = useSession((s) => s.settings.presentationMode === true);
  const style = useSession((s) => s.settings.maskStyle ?? 'initial');
  const id = useSession((s) => s.activeConfig?.id ?? null);
  const rules = useSession((s) => (id ? s.settings.maskRules?.[id] : undefined));
  return useMemo(
    () => ({ active, style, rules: rules ?? EMPTY_MASK_RULES, connectionId: id }),
    [active, style, rules, id],
  );
}

/** Which columns of a result are sensitive (empty when presentation mode is off). */
export function detectMaskedColumns(
  columns: readonly ColumnMeta[] | undefined,
  rows: readonly unknown[][] | undefined,
  rules: MaskRules,
): ReadonlyMap<number, ColumnMask> {
  if (!columns || columns.length === 0) return NO_MASKS;
  return resolveMaskedColumns(
    columns,
    (col) =>
      (rows ?? []).slice(0, SAMPLE_ROWS).map((r) => cellToText(r[col], columns[col]?.dataTypeName)),
    rules,
  );
}

export interface GridMasking {
  active: boolean;
  /** Sensitive columns (by result column index). */
  masked: ReadonlyMap<number, ColumnMask>;
  /** True when this cell is hidden right now (sensitive column, not revealed). */
  isHidden(rowIndex: number, col: number): boolean;
  /** Masked text for a cell, or the text itself when it is not hidden. */
  show(text: string | null | undefined, rowIndex: number, col: number): string | null | undefined;
  /** Row copy with hidden cells replaced by their masked text (clipboard, row viewer). */
  maskRow(row: readonly unknown[], rowIndex: number): unknown[];
  reveal(rowIndex: number, col: number): void;
}

/**
 * Masking for one result grid: which columns are sensitive (name rules, then
 * value sampling over the first rows, then the connection's own rules) and
 * which cells the user has revealed for now.
 */
export function useGridMasking(
  tabId: string,
  columns: readonly ColumnMeta[] | undefined,
  rows: readonly unknown[][] | undefined,
): GridMasking {
  const { active, style, rules } = usePresentation();
  const revealed = useReveal((s) => s.revealed);
  const masked = useMemo(
    () => (active ? detectMaskedColumns(columns, rows, rules) : NO_MASKS),
    [active, columns, rows, rules],
  );

  const isHidden = useCallback(
    (rowIndex: number, col: number) =>
      masked.has(col) && !isRevealed(revealed, revealKey(tabId, rowIndex, col)),
    [masked, revealed, tabId],
  );
  const show = useCallback(
    (text: string | null | undefined, rowIndex: number, col: number) => {
      const m = masked.get(col);
      if (!m || text === null || text === undefined) return text;
      if (isRevealed(revealed, revealKey(tabId, rowIndex, col))) return text;
      return maskValue(text, m.kind, style);
    },
    [masked, revealed, style, tabId],
  );
  const maskRow = useCallback(
    (row: readonly unknown[], rowIndex: number) =>
      row.map((v, col) => {
        const m = masked.get(col);
        if (!m || v === null || v === undefined) return v;
        if (isRevealed(revealed, revealKey(tabId, rowIndex, col))) return v;
        return maskValue(cellToText(v, columns?.[col]?.dataTypeName), m.kind, style);
      }),
    [masked, revealed, style, tabId, columns],
  );
  const reveal = useCallback(
    (rowIndex: number, col: number) => useReveal.getState().reveal(revealKey(tabId, rowIndex, col)),
    [tabId],
  );
  return useMemo(
    () => ({ active, masked, isHidden, show, maskRow, reveal }),
    [active, masked, isHidden, show, maskRow, reveal],
  );
}

/**
 * Copy of `result` safe to leave the app (clipboard exports): sensitive
 * columns masked when presentation mode is on, `result` itself otherwise.
 */
export function maskResultForClipboard(result: QueryResult): QueryResult {
  const cfg = presentationConfig();
  if (!cfg.active) return result;
  const masks = detectMaskedColumns(result.columns, result.rows, cfg.rules);
  if (masks.size === 0) return result;
  return {
    ...result,
    rows: result.rows.map((row) =>
      row.map((v, col) => {
        const m = masks.get(col);
        if (!m || v === null || v === undefined) return v;
        return maskValue(cellToText(v, result.columns[col]?.dataTypeName), m.kind, cfg.style);
      }),
    ),
  };
}

// ─── Per-connection column rules ─────────────────────────────────────

type RuleChange = 'sensitive' | 'plain' | 'reset';

/** Add a column to (or remove it from) the active connection's mask rules. */
export function setColumnMaskRule(columnName: string, change: RuleChange): void {
  const s = useSession.getState();
  const id = s.activeConfig?.id;
  if (!id) return;
  const all = s.settings.maskRules ?? {};
  const cur = all[id] ?? EMPTY_MASK_RULES;
  const next =
    change === 'sensitive'
      ? withSensitiveColumn(cur, columnName)
      : change === 'plain'
        ? withPlainColumn(cur, columnName)
        : withoutColumnRule(cur, columnName);
  void s.updateSettings({ maskRules: { ...all, [id]: next } });
}

/** True while presentation mode is on (hosts, paths and other screen-share giveaways hide). */
export function usePresenting(): boolean {
  return useSession((s) => s.settings.presentationMode === true);
}

/** Replace the host part of an endpoint label while presenting. */
export function hostLabel(presenting: boolean, host: string, port?: number | string): string {
  if (presenting) return '•••';
  return port === undefined ? host : `${host}:${port}`;
}

/**
 * Window title: names the connection normally, only "Plasma" while presenting
 * (the OS shows it in the title bar, the task switcher and screenshots), and
 * drops every revealed cell whenever the mode flips.
 */
export function usePresentationWindowTitle(): void {
  const presenting = usePresenting();
  const name = useSession((s) => (s.connectionState === 'connected' ? s.activeConfig?.name : null));
  const host = useSession((s) => (s.connectionState === 'connected' ? s.activeConfig?.host : null));
  const port = useSession((s) => s.activeConfig?.port);
  useEffect(() => {
    document.title =
      presenting || !name ? 'Plasma' : `${name}${host ? ` (${host}:${port})` : ''} - Plasma`;
  }, [presenting, name, host, port]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear reveals whenever the mode flips
  useEffect(() => {
    useReveal.getState().clear();
  }, [presenting]);
}
