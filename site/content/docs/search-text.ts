import { isValidElement, type ReactNode } from 'react';

/** Props that never hold readable text. */
const SKIP = new Set(['className', 'href', 'id', 'src', 'key', 'ref', 'style', 'width', 'height', 'lang', 'tone']);

/**
 * The readable text of a docs body, for search. Walks the element tree and
 * collects every string it finds in children and in data props (table rows,
 * code, step lists), so the custom components need no special casing.
 */
export function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) if (!SKIP.has(k)) textOf(v, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) textOf(v, out);
  }
  return out;
}

export function plainText(node: ReactNode): string {
  return textOf(node).join(' ').replace(/\s+/g, ' ').trim();
}
