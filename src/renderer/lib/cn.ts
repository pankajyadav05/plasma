import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Classname joiner. Uses `clsx` to handle conditional/array/object
 * inputs, then `tailwind-merge` to dedupe conflicting Tailwind classes
 * (e.g. `px-2` losing to `px-4` when both appear).
 *
 * This is the standard shadcn/ui pattern.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
