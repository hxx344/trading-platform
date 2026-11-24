// The MCP `snapshot` tool's rows (docs/mcp.md 8.5): the workbench's agent-feed format (entity, metric, label, value,
// unit, asOf, stale, status) built in the MCP server from routes the token already reads. Every row comes from the
// tables here, field by field, so a field the platform adds later never shows up by itself. No dependency on
// readonly.ts: it hands in `read`, which turns each GET into a value or a reason.

export type SnapshotScope = 'system' | 'public';
export const SNAPSHOT_GROUPS = [
  { id: 'system.host', scope: 'system', about: '服务器：CPU 占用与核数、1/5/15 分钟负载、内存与交换区、数据目录与系统盘、开机时长' },
  { id: 'system.runtime', scope: 'system', about: '交易服务：运行时长、数据库 WAL 与写入等待、各执行循环的连续失败次数与距上次成功的秒数、行情服务与控制面进程、未恢复的告警数、进程内存与事件循环延迟、各服务连线' },
  { id: 'market.monitor', scope: 'public', about: '行情监控的报价摘要：原油（Brent、WTI 与价差、资金费率）、金油比、海力士（ADR、本股折算与溢价）、Anthropic 各场所价格与资金费率' },
] as const satisfies readonly { id: string; scope: SnapshotScope; about: string }[];
export type SnapshotGroupId = typeof SNAPSHOT_GROUPS[number]['id'];
export const SNAPSHOT_GROUP_IDS: readonly SnapshotGroupId[] = SNAPSHOT_GROUPS.map(group => group.id);

/** One GET: its body, or why it could not be read. `read` throws only for errors that end the whole call (a bad token). */
export type Source = { ok: true; value: unknown } | { ok: false; message: string; rateLimited?: boolean };
export type Read = (path: string) => Promise<Source>;

export type RowStatus = 'ok' | 'warn' | 'down' | 'unknown';
export interface SnapshotRow { entity: string; metric: string; label: string; value: number | null; unit: string; asOf: string | null; stale: boolean; status: RowStatus }
export interface SnapshotGroup { id: SnapshotGroupId; scope: SnapshotScope; status: 'ok' | 'partial' | 'unavailable'; message: string | null; asOf: string | null; rows: SnapshotRow[] }
/** `rateLimited`: some source was refused by the token's per-minute or concurrent limit (429); wait before calling again. */
export interface Snapshot { schemaVersion: 1; generatedAt: string; rateLimited: boolean; groups: SnapshotGroup[] }

/** A source read within this long is reused; rows (and `stale`) are still worked out at each call. */
export const SNAPSHOT_CACHE_MS = 5_000;
/** System rows describe the moment the platform answered; past this they are stale (a cached read is at most 5 s old). */
const SYSTEM_TTL_MS = 60_000;
/** A quote without its own staleAfterMs. */
const QUOTE_TTL_MS = 120_000;
const MAX_LOOPS = 50;
export const QUOTE_MARKETS = ['oil', 'goldoil', 'hynix', 'anthropic'] as const;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const at = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
};
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const round = (value: number | null, digits = 3): number | null => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Rows of one source, sharing its time and freshness. */
function rows(now: number, asOf: number | null, ttlMs: number, forceStale = false) {
  const list: SnapshotRow[] = [];
  const stale = forceStale || asOf === null || now - asOf > ttlMs;
  return {
    list,
    add(entity: string, metric: string, label: string, value: number | null, unit: string, status?: RowStatus) {
      list.push({ entity, metric, label, value, unit, asOf: iso(asOf), stale, status: status ?? (value === null ? 'unknown' : 'ok') });
    },
  };
}

function hostRows(host: Json, now: number): SnapshotRow[] {
  const out = rows(now, at(host.generatedAt), SYSTEM_TTL_MS);
  const cpu = object(host.cpu), memory = object(host.memory), swap = object(memory?.swap);
  const load = Array.isArray(cpu?.loadAverage) ? cpu.loadAverage : [];
  out.add('host', 'cpu.usage', 'CPU 占用', num(cpu?.usagePercent), '%');
  out.add('host', 'cpu.cores', 'CPU 核数', num(cpu?.cores), 'count');
  out.add('host', 'load.1m', '1 分钟负载', num(load[0]), 'load');
  out.add('host', 'load.5m', '5 分钟负载', num(load[1]), 'load');
  out.add('host', 'load.15m', '15 分钟负载', num(load[2]), 'load');
  out.add('host', 'memory.used_percent', '内存占用', num(memory?.usedPercent), '%');
  out.add('host', 'memory.used', '已用内存', num(memory?.usedBytes), 'bytes');
  out.add('host', 'memory.available', '可用内存', num(memory?.availableBytes), 'bytes');
  out.add('host', 'memory.total', '内存总量', num(memory?.totalBytes), 'bytes');
  out.add('host', 'swap.used_percent', '交换区占用', num(swap?.usedPercent), '%');
  out.add('host', 'swap.used', '已用交换区', num(swap?.usedBytes), 'bytes');
  out.add('host', 'swap.total', '交换区总量', num(swap?.totalBytes), 'bytes');
  out.add('host', 'uptime', '开机时长', num(host.uptimeSeconds), 's');
  const names: Record<string, string> = { data: '数据目录所在磁盘', root: '系统盘' };
  for (const disk of Array.isArray(host.disks) ? host.disks : []) {
    const row = object(disk);
    const id = row?.id;
    if (typeof id !== 'string' || !Object.hasOwn(names, id)) continue;
    const name = names[id]!;
    out.add(`disk:${id}`, 'used_percent', `${name}占用`, num(row!.usedPercent), '%');
    out.add(`disk:${id}`, 'used', `${name}已用`, num(row!.usedBytes), 'bytes');
    out.add(`disk:${id}`, 'available', `${name}可用`, num(row!.availableBytes), 'bytes');
    out.add(`disk:${id}`, 'total', `${name}总量`, num(row!.totalBytes), 'bytes');
  }
  return out.list;
}

const CONNECTION_LABELS: Record<string, string> = { market: '行情服务', control: '页面控制面', streams: 'ASTER 用户推送', perpetual: '永续行情', heartbeat: '副服务器心跳' };
const CONNECTION_STATES: Record<string, { value: number | null; status: RowStatus }> = { ok: { value: 1, status: 'ok' }, warn: { value: 1, status: 'warn' }, down: { value: 0, status: 'down' }, unknown: { value: null, status: 'unknown' } };

/** The /api/status half of system.runtime. */
function statusRows(status: Json, now: number): SnapshotRow[] {
  const health = object(status.health);
  const healthAt = at(health?.now);
  const service = rows(now, healthAt, SYSTEM_TTL_MS);
  const startedAt = at(health?.startedAt);
  service.add('service', 'uptime', '交易服务运行时长', healthAt !== null && startedAt !== null ? round((healthAt - startedAt) / 1000, 0) : null, 's');
  const retired = health?.retired;
  service.add('service', 'retired', '已交出执行权（1 为是）', typeof retired === 'boolean' ? retired ? 1 : 0 : null, 'bool', typeof retired === 'boolean' ? retired ? 'down' : 'ok' : 'unknown');
  service.add('service', 'wal.size', '数据库 WAL 大小', num(health?.walBytes), 'bytes');
  service.add('service', 'wal.limit', '数据库 WAL 上限', num(health?.walLimitBytes), 'bytes');
  const writes = object(health?.writes);
  service.add('service', 'writes.busy', '写入遇忙次数', num(writes?.busy), 'count');
  service.add('service', 'writes.max_wait', '写入最长等待', num(writes?.maxWaitMs), 'ms');
  service.add('service', 'writes.max_hold', '写入最长占用', num(writes?.maxHoldMs), 'ms');
  for (const loop of (Array.isArray(health?.loops) ? health.loops : []).slice(0, MAX_LOOPS)) {
    const row = object(loop);
    if (typeof row?.name !== 'string' || !row.name) continue;
    const name = row.name.slice(0, 40);
    const failures = num(row.failures), lastOk = at(row.lastOkAt);
    service.add(`loop:${name}`, 'failures', `${name}：连续失败次数`, failures, 'count', failures === null ? 'unknown' : failures > 0 ? 'warn' : 'ok');
    service.add(`loop:${name}`, 'since_ok', `${name}：距上次成功`, healthAt !== null && lastOk !== null ? round((healthAt - lastOk) / 1000, 0) : null, 's');
  }
  const dependencies = object(status.dependencies);
  const list = [...service.list];
  for (const [id, label] of [['market', '行情服务进程'], ['control', '页面控制面进程']] as const) {
    const row = object(dependencies?.[id]);
    if (!row) continue;
    const checked = rows(now, at(row.checkedAt), SYSTEM_TTL_MS);
    const ok = row.ok;
    checked.add(`process:${id}`, 'up', `${label}可连接（1 为是）`, ok === true ? 1 : ok === false ? 0 : null, 'bool', ok === true ? 'ok' : ok === false ? 'down' : 'unknown');
    // Only the market process's restarts are counted (its instance id); the control process's 0 is not a measurement.
    if (id === 'market') checked.add(`process:${id}`, 'restarts', `${label}本次启动以来重启次数`, num(row.restarts), 'count');
    list.push(...checked.list);
  }
  if (dependencies && Array.isArray(dependencies.incidents)) {
    const open = dependencies.incidents.length;
    const incidents = rows(now, healthAt, SYSTEM_TTL_MS);
    incidents.add('service', 'incidents.open', '未恢复的依赖告警', open, 'count', open > 0 ? 'warn' : 'ok');
    list.push(...incidents.list);
  }
  return list;
}

/** The /api/host half of system.runtime: the trading process and its connections. */
function hostProcessRows(host: Json, now: number): SnapshotRow[] {
  const hostAt = at(host.generatedAt);
  const proc = rows(now, hostAt, SYSTEM_TTL_MS);
  const serviceProcess = object(host.process), delay = object(serviceProcess?.loopDelayMs);
  proc.add('process:trading', 'rss', '交易服务常驻内存', num(serviceProcess?.rssBytes), 'bytes');
  proc.add('process:trading', 'heap_used', '交易服务堆内存', num(serviceProcess?.heapUsedBytes), 'bytes');
  proc.add('process:trading', 'uptime', '交易服务进程运行时长', num(serviceProcess?.uptimeSeconds), 's');
  proc.add('process:trading', 'loop_delay.mean', '事件循环延迟（平均）', num(delay?.mean), 'ms');
  proc.add('process:trading', 'loop_delay.p99', '事件循环延迟（p99）', num(delay?.p99), 'ms');
  proc.add('process:trading', 'loop_delay.max', '事件循环延迟（最大）', num(delay?.max), 'ms');
  for (const connection of Array.isArray(host.connections) ? host.connections : []) {
    const row = object(connection);
    const id = row?.id;
    if (typeof id !== 'string' || !Object.hasOwn(CONNECTION_LABELS, id)) continue;
    const state = typeof row!.state === 'string' && Object.hasOwn(CONNECTION_STATES, row!.state) ? CONNECTION_STATES[row!.state]! : CONNECTION_STATES.unknown!;
    proc.add(`connection:${id}`, 'state', `${CONNECTION_LABELS[id]}连线（1 为连通，0 为断开）`, state.value, 'bool', state.status);
  }
  return proc.list;
}

function quoteRows(market: typeof QUOTE_MARKETS[number], quote: Json, now: number): SnapshotRow[] {
  const ttl = num(quote.staleAfterMs) ?? QUOTE_TTL_MS;
  const out = rows(now, at(quote.fetchedAt), ttl, quote.status !== 'live');
  const entity = `monitor:${market}`;
  const leg = (name: string) => object(quote[name]);
  if (market === 'oil') {
    const brent = num(leg('brent')?.markPx), wti = num(leg('wti')?.markPx);
    out.add(entity, 'brent.price', 'Brent 标记价', brent, 'USDT');
    out.add(entity, 'wti.price', 'WTI 标记价', wti, 'USDT');
    out.add(entity, 'spread', 'Brent − WTI 价差', brent !== null && wti !== null ? round(brent - wti, 6) : null, 'USDT');
    out.add(entity, 'brent.funding', 'Brent 资金费率（每期，期长见 brent.funding_interval）', num(leg('brent')?.fundingRate), 'ratio');
    out.add(entity, 'brent.funding_interval', 'Brent 资金费结算间隔', num(leg('brent')?.fundingIntervalHours), 'h');
    out.add(entity, 'wti.funding', 'WTI 资金费率（每期，期长见 wti.funding_interval）', num(leg('wti')?.fundingRate), 'ratio');
    out.add(entity, 'wti.funding_interval', 'WTI 资金费结算间隔', num(leg('wti')?.fundingIntervalHours), 'h');
  } else if (market === 'goldoil') {
    const ratio = object(quote.ratio);
    out.add(entity, 'xau.price', '黄金标记价', num(leg('xau')?.price), 'USDT');
    out.add(entity, 'cl.price', 'WTI 标记价', num(leg('cl')?.price), 'USDT');
    out.add(entity, 'bz.price', 'Brent 标记价', num(leg('bz')?.price), 'USDT');
    out.add(entity, 'ratio.cl', '金油比（XAU ÷ WTI）', num(ratio?.cl), 'bbl/oz');
    out.add(entity, 'ratio.bz', '金油比（XAU ÷ Brent）', num(ratio?.bz), 'bbl/oz');
  } else if (market === 'hynix') {
    out.add(entity, 'adr.price', '海力士 ADR 价格', num(quote.adr), 'USD');
    out.add(entity, 'ordinary.price', '海力士本股价格', num(quote.ordinary), 'USD');
    out.add(entity, 'equivalent', '本股折算 ADR 价格', num(quote.equivalent), 'USD');
    out.add(entity, 'spread', 'ADR − 折算价', num(quote.spread), 'USD');
    out.add(entity, 'premium', 'ADR 溢价', num(quote.premium), '%');
  } else {
    // Binance quotes the contract in USDT and settles funding every few hours; Hyperliquid funding is hourly.
    for (const [name, label, unit, period] of [['binance', 'Binance', 'USDT', '每期'], ['xyz', 'Hyperliquid xyz', 'USD', '每小时'], ['io', 'Hyperliquid io', 'USD', '每小时'], ['rh', 'RH Lighter', 'USD', '每期']] as const) {
      out.add(entity, `${name}.price`, `Anthropic ${label} 标记价`, num(leg(name)?.markPx), unit);
      out.add(entity, `${name}.funding`, `Anthropic ${label} 资金费率（${period}）`, num(leg(name)?.fundingRate), 'ratio');
    }
  }
  return out.list;
}

const latest = (list: readonly SnapshotRow[]): string | null => list.reduce<string | null>((best, row) => row.asOf !== null && (best === null || row.asOf > best) ? row.asOf : best, null);
/** ok with every source read, partial with some, unavailable with none; `message` gives each source that was missing. */
const group = (id: SnapshotGroupId, scope: SnapshotScope, list: SnapshotRow[], missing: readonly string[]): SnapshotGroup => ({
  id, scope, status: missing.length === 0 ? 'ok' : list.length ? 'partial' : 'unavailable', message: missing.length ? missing.join('；') : null, asOf: latest(list), rows: list,
});

/**
 * The snapshot builder: one per platform connection. Each GET is reused for SNAPSHOT_CACHE_MS after it settles (one read
 * in flight per path), reads run one after another (a token may have only 2 requests open), and a group whose sources
 * cannot be read comes back `partial` or `unavailable` while the others still answer.
 */
export function createSnapshot(read: Read, now: () => number = Date.now) {
  // `at` is stamped when the read settles: a read still pending is always shared, however long it takes.
  const cache = new Map<string, { at: number | null; value: Promise<Source> }>();
  const cached = (path: string): Promise<Source> => {
    const hit = cache.get(path);
    if (hit && (hit.at === null || now() - hit.at < SNAPSHOT_CACHE_MS)) return hit.value;
    const value = read(path);
    const entry: { at: number | null; value: Promise<Source> } = { at: null, value };
    cache.set(path, entry);
    value.then(() => { entry.at = now(); }, () => { if (cache.get(path) === entry) cache.delete(path); });
    return value;
  };
  return async (ids: readonly SnapshotGroupId[]): Promise<Snapshot> => {
    const groups: SnapshotGroup[] = [];
    let rateLimited = false;
    const source = async (path: string): Promise<Source> => { const answer = await cached(path); if (!answer.ok && answer.rateLimited) rateLimited = true; return answer; };
    for (const { id, scope } of SNAPSHOT_GROUPS.filter(group => ids.includes(group.id))) {
      if (id === 'system.host') {
        const host = await source('/api/host');
        const value = host.ok ? object(host.value) : null;
        groups.push(!host.ok ? group(id, scope, [], [host.message]) : !value ? group(id, scope, [], ['/api/host 的应答不是对象']) : group(id, scope, hostRows(value, now()), []));
      } else if (id === 'system.runtime') {
        // Two sources: one that cannot be read leaves the other's rows, and the group is partial.
        const list: SnapshotRow[] = [], missing: string[] = [];
        for (const [path, build] of [['/api/status', statusRows], ['/api/host', hostProcessRows]] as const) {
          const answer = await source(path);
          const value = answer.ok ? object(answer.value) : null;
          if (!answer.ok) missing.push(answer.message);
          else if (!value) missing.push(`${path} 的应答不是对象`);
          else list.push(...build(value, now()));
        }
        groups.push(group(id, scope, list, missing));
      } else {
        const list: SnapshotRow[] = [], missing: string[] = [];
        for (const market of QUOTE_MARKETS) {
          const quote = await source(`/api/monitor/${market}/quote`);
          const value = quote.ok ? object(quote.value) : null;
          if (!quote.ok) missing.push(`${market}：${quote.message}`);
          else if (quote.value === null) missing.push(`${market}：采集器还没有报价`);
          else if (!value) missing.push(`${market}：应答不是对象`);
          else list.push(...quoteRows(market, value, now()));
        }
        groups.push(group(id, scope, list, missing));
      }
    }
    return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), rateLimited, groups };
  };
}
