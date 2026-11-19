import { createHash } from 'node:crypto';
import { MAX_VIEW_LENGTH, MAX_VIEW_PARTS, READ_BASE, READ_VERSION, ReadViewCache, readVersion, type ViewPart } from './read-view.ts';

/** Reuse unchanged runs, including rows shifted by a new fill, a correction or a sliding time window. */
function viewDelta(old: string, next: string): string | undefined {
  const block = 48;
  if (next.length < 256) return;
  let prefix = 0, oldEnd = old.length, end = next.length;
  while (prefix < oldEnd && prefix < end && old.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  while (oldEnd > prefix && end > prefix && old.charCodeAt(oldEnd - 1) === next.charCodeAt(end - 1)) { oldEnd--; end--; }
  const parts: ViewPart[] = [];
  if (prefix) parts.push([0, prefix]);
  let literal = prefix;
  if (end - prefix >= block && oldEnd - prefix >= block) {
    const anchors = new Map<string, number>();
    for (let i = prefix; i + block <= oldEnd; i += block) anchors.set(old.slice(i, i + block), i);
    // Limit unsuccessful searches on entirely different ledgers. A full reply always works.
    let misses = 0;
    for (let i = prefix; i + block <= end && misses < 65_536;) {
      const at = anchors.get(next.slice(i, i + block));
      if (at === undefined) { i++; misses++; continue; }
      if (i > literal) parts.push(next.slice(literal, i));
      let count = block;
      while (at + count < oldEnd && i + count < end && old.charCodeAt(at + count) === next.charCodeAt(i + count)) count++;
      parts.push([at, count]);
      if (parts.length >= MAX_VIEW_PARTS - 2) return;
      i += count;
      literal = i;
    }
  }
  if (literal < end) parts.push(next.slice(literal, end));
  if (end < next.length) parts.push([oldEnd, next.length - end]);
  const patch = JSON.stringify(parts);
  return Buffer.byteLength(patch) + 64 < Buffer.byteLength(next) ? patch : undefined;
}

export function readViewReply(cache: ReadViewCache, key: string, known: string, body: unknown) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (!text || text.length > MAX_VIEW_LENGTH) { cache.delete(key); return { status: 200, text, headers }; }
  const previous = cache.get(key);
  const version = previous?.text === text ? previous.version :
    readVersion(createHash('sha256').update(text).digest('hex'), text.length);
  headers[READ_VERSION] = version;
  if (previous?.version !== version) cache.set(key, { text, version });
  if (known === version) return { status: 204, text: '', headers };
  if (previous && previous.version === known) {
    const patch = viewDelta(previous.text, text);
    if (patch !== undefined) { headers[READ_BASE] = known; return { status: 200, text: patch, headers }; }
  }
  return { status: 200, text, headers };
}
