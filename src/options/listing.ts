import { VenueError } from '../connector.ts';
import { isRecord } from '../live/http.ts';
import type { Row } from './client.ts';

export const MAX_PAGES = 100;
/** A shared pagination contract for the Bybit signed listings and the public instrument catalogue. */
export async function bybitPages(read: (cursor: string) => Promise<Row>, identity: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [], seenRows = new Set<string>(), seenCursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await read(cursor);
    if (!Array.isArray(data.list) || data.list.some(item => !isRecord(item))) throw new VenueError('read-failed', 'Bybit 列表格式无效');
    for (const row of data.list as Row[]) {
      const fields = identity.map(field => row[field]);
      if (fields.some(value => typeof value !== 'string') || !fields[0]) throw new VenueError('read-failed', 'Bybit 列表行缺少标识');
      const key = JSON.stringify(fields);
      if (!seenRows.has(key)) { seenRows.add(key); rows.push(row); }
    }
    const next = data.nextPageCursor;
    if (next === undefined || next === null || next === '') return rows;
    if (typeof next !== 'string' || next.length > 2000 || seenCursors.has(next)) throw new VenueError('read-failed', 'Bybit 分页游标无效或重复');
    seenCursors.add(next); cursor = next;
  }
  throw new VenueError('read-failed', 'Bybit 列表超过 100 页');
}
