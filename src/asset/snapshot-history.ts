// Copied from project_aggregation modules/asset/lib/snapshot-history.ts at 0014655. The calculation is unchanged.
// Changes:
// - the database type is QueryDatabase (query.ts) instead of the workbench openDatabase wrapper;
// - no owner: this service has one user, so the owner parameter and the `owner = ?` conditions are gone.
import type { QueryDatabase } from './query.ts';
import type { Period } from './types.ts';
import { missingValueSql } from './asset-values.ts';

type SnapshotDatabase = QueryDatabase;
type SnapshotRow = { data: string; withdrawn: number; missingValues: number };

export async function readSnapshotHistory(database: SnapshotDatabase): Promise<Period[]> {
  // Overall performance needs every daily snapshot. Imported archive-* keys
  // remain bounded independently so they never displace the valid daily history.
  const fields = `json_remove(s.data, '$.assets', '$.positions') AS data, COALESCE(json_extract(s.data, '$.withdrawn'), (SELECT TOTAL(json_extract(a.value, '$.value')) FROM json_each(s.data, '$.assets') a WHERE trim(json_extract(a.value, '$.project')) = '出金')) AS withdrawn, (SELECT COUNT(*) FROM json_each(s.data, '$.assets') a WHERE ${missingValueSql('a.value')}) AS missingValues`;
  const rows = await Promise.all([
    database.prepare(`SELECT ${fields} FROM snapshots s WHERE date < 'a' ORDER BY date DESC`).all<SnapshotRow>(),
    database.prepare(`SELECT ${fields} FROM snapshots s WHERE date >= 'a' ORDER BY json_extract(s.data, '$.date') DESC LIMIT 730`).all<SnapshotRow>(),
  ]);
  return rows.flatMap(result => result.results.map(row => {
    const snapshot = JSON.parse(row.data) as Period;
    const missingValues = Math.max(snapshot.missingValues ?? 0, row.missingValues);
    return { ...snapshot, withdrawn: row.withdrawn, ...(missingValues ? {partial:true,missingValues} : {}) };
  }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
