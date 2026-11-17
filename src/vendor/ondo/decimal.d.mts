// Types for decimal.mjs, only what the service's TypeScript uses.
/** A decimal string as an integer scaled by 10^18. */
export function decimalUnits(value: string): bigint;
/** The inverse of decimalUnits, without trailing zeros. */
export function formatDecimalUnits(value: bigint): string;
