/**
 * Class names, merged so the last one wins.
 *
 * Tailwind's utilities all have the same specificity, so `p-2` and `p-4` on
 * one element is settled by their order in the stylesheet rather than in the
 * string — which means a component that takes a className cannot reliably
 * override its own defaults without this.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
