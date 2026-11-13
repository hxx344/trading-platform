// The query shape of the workbench's database wrapper (project_aggregation modules/asset/lib/sqlite.ts at 0014655):
// prepare(sql).bind(...).first()/all(). The copied readers take this type instead of ReturnType<typeof openDatabase>,
// so they stay free of node:sqlite and the page can import their result types.
export type QueryValue = string | number | null | Uint8Array;
export interface QueryStatement {
  bind(...values: QueryValue[]): QueryStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface QueryDatabase { prepare(sql: string): QueryStatement }
