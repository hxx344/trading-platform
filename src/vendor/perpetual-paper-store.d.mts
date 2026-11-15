// Types for perpetual-paper-store.mjs (the workbench's paper-position store, c84ba27).
import type { PerpetualPaperState } from './perpetual-paper.ts';
import type { PerpetualPaperStore } from './perpetual-paper-service.mjs';

/** A normalized copy of a valid state; throws `Invalid paper-position state` otherwise (never repairs or drops entries). */
export declare function validatePerpetualPaperState(input: unknown): PerpetualPaperState;
/** The workbench's asynchronous store (`<directory>/paper-positions.json`); this service opens its own synchronously (src/monitor/perpetual-paper-store.ts). */
export declare function openPerpetualPaperStore(directory: string): Promise<PerpetualPaperStore>;
