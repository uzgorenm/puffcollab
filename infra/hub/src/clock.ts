// @effect-diagnostics globalDate:off - the one wall-clock read for the Worker and Durable Objects.

/** Epoch milliseconds. */
export const nowMs = (): number => Date.now();

export const isoOf = (ms: number): string => new Date(ms).toISOString();

export const msOf = (iso: string): number => Date.parse(iso);
