// Types for statement-cache.mjs.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
export function createStatementCache(db: DatabaseSync, limit?: number): { prepare(sql: string): StatementSync; clear(): void };
