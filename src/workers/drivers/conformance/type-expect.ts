import { expect } from 'vitest';

/**
 * Assertions on the cells the grid receives. The representation is part of
 * the driver contract (docs/driver-contract.md, "Values"): these helpers are
 * the executable form of it, shared by every engine's type cases.
 */

/** An integer cell is a safe JS number or the exact decimal text, never a rounded number. */
export function expectLosslessInt(cell: unknown, digits: string): void {
  if (typeof cell === 'number') {
    expect(Number.isSafeInteger(cell), `${cell} is not a safe integer`).toBe(true);
    expect(String(cell)).toBe(digits);
  } else {
    expect(cell).toBe(digits);
  }
}

/** A decimal / numeric cell arrives as its exact text. */
export const exactText = (text: string) => (cell: unknown) => expect(cell).toBe(text);

/** An integer column: lossless number-or-text. */
export const int = (digits: string) => (cell: unknown) => expectLosslessInt(cell, digits);

/** A floating-point column: a JS number with the shortest round-trip value. */
export const float = (n: number) => (cell: unknown) => expect(cell).toBe(n);

/** A boolean column: `true`/`false`, or 1/0 on engines that store booleans as integers. */
export const bool = (value: boolean, as: 'boolean' | 'integer') => (cell: unknown) =>
  expect(cell).toBe(as === 'boolean' ? value : value ? 1 : 0);

/** A JSON column: a parsed value or the JSON text of it; both are valid grid input. */
export const json = (value: unknown) => (cell: unknown) => {
  const parsed = typeof cell === 'string' ? JSON.parse(cell) : cell;
  expect(parsed).toEqual(value);
};

/** A binary column: `\x` + lowercase hex text. */
export const bytes = (hex: string) => (cell: unknown) => expect(cell).toBe(`\\x${hex}`);

/** Epoch milliseconds of a timestamp text with an offset (`+02`, `+05:30`, `Z`, or none = UTC). */
export function instantMs(text: string): number {
  const iso = text
    .trim()
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

/** A timestamp-with-zone column keeps the instant, whatever offset the server prints it in. */
export const instant = (iso: string) => (cell: unknown) => {
  expect(typeof cell).toBe('string');
  expect(instantMs(cell as string)).toBe(Date.parse(iso));
};
