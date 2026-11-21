// Server load for the badge at the page's top right (web/src/HostStatusBadge.tsx): CPU, memory, the data directory's
// disk and the system disk, plus this service's own memory and event-loop delay. Only local system calls, no network;
// no paths, hostnames or process ids in the answer. Ported from the workbench (project-aggregation
// server/host-status.mjs @ 52337a9); the process part is new here.
import os from 'node:os';
import { readFile, stat, statfs } from 'node:fs/promises';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const CPU_MIN_INTERVAL_MS = 1_000;
const CPU_FIRST_SAMPLE_MS = 250;
const CPU_MAX_INTERVAL_MS = 30_000;
/** The event-loop figures cover at most about this long before they start over. */
export const LOOP_WINDOW_MS = 60_000;

export interface HostDisk { id: 'data' | 'root'; label: string; error?: string; totalBytes?: number; availableBytes?: number; usedBytes?: number; usedPercent?: number | null }
export interface HostStatus {
  generatedAt: number;
  cpu: { usagePercent: number | null; cores: number; loadAverage: number[] };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number | null; swap: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null };
  disks: HostDisk[];
  uptimeSeconds: number;
  /** The trading service process itself. */
  process: { rssBytes: number; heapUsedBytes: number; uptimeSeconds: number; loopDelayMs: { mean: number; p99: number; max: number } | null };
}

interface CpuSample { busy: number; total: number; cores: number }
const cpuTimes = (list: os.CpuInfo[]): CpuSample => list.reduce((sum, cpu) => {
  const { user, nice, sys, idle, irq } = cpu.times;
  return { ...sum, busy: sum.busy + user + nice + sys + irq, total: sum.total + user + nice + sys + idle + irq };
}, { busy: 0, total: 0, cores: list.length });
const percent = (part: number, whole: number): number | null => whole > 0 ? Math.min(100, Math.max(0, Math.round(part / whole * 1000) / 10)) : null;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

async function readSwap(meminfo: () => Promise<string>): Promise<HostStatus['memory']['swap']> {
  try {
    const text = await meminfo();
    const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text); return match ? Number(match[1]) * 1024 : null; };
    const total = field('SwapTotal'), free = field('SwapFree');
    return total === null || free === null ? null : { totalBytes: total, usedBytes: total - free, usedPercent: percent(total - free, total) };
  } catch { return null; }
}

export interface HostStatusOptions {
  dataDir?: string;
  now?: () => number;
  cpus?: () => os.CpuInfo[];
  totalmem?: () => number;
  freemem?: () => number;
  loadavg?: () => number[];
  uptime?: () => number;
  meminfo?: () => Promise<string>;
  statDisk?: (path: string) => Promise<{ blocks: number; bfree: number; bavail: number; bsize: number }>;
  statPath?: (path: string) => Promise<{ dev: number }>;
  wait?: (ms: number) => Promise<void>;
  memoryUsage?: () => { rss: number; heapUsed: number };
  /** The event-loop histogram; null leaves the delay out. */
  loop?: Pick<IntervalHistogram, 'mean' | 'max' | 'percentile' | 'reset' | 'count'> | null;
}

/**
 * CPU usage is the busy share between two readings of the kernel counters. The first read, and any read more than
 * CPU_MAX_INTERVAL_MS after the previous one (which would otherwise report the average over the whole gap), samples
 * twice, CPU_FIRST_SAMPLE_MS apart. Other reads compare with the previous reading, and reads closer than
 * CPU_MIN_INTERVAL_MS reuse the last value, so several open tabs polling every 3 s do not shrink the window.
 */
export function createHostStatus({ dataDir, now = Date.now, cpus = os.cpus, totalmem = os.totalmem, freemem = os.freemem, loadavg = os.loadavg, uptime = os.uptime,
  meminfo = () => readFile('/proc/meminfo', 'utf8'), statDisk = statfs, statPath = stat, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  memoryUsage = () => process.memoryUsage(), loop }: HostStatusOptions = {}) {
  let last: (CpuSample & { at: number }) | null = null, usage: number | null = null, first: Promise<void> | null = null, cores = 0;
  const sample = () => { const list = cpus(); cores = list.length; return cpuTimes(list); };
  async function cpuUsage(): Promise<number | null> {
    if (!last || now() - last.at > CPU_MAX_INTERVAL_MS) {
      first ??= (async () => {
        const start = sample();
        await wait(CPU_FIRST_SAMPLE_MS);
        const end = sample();
        usage = percent(end.busy - start.busy, end.total - start.total);
        last = { at: now(), ...end };
      })().finally(() => { first = null; });
      await first;
      return usage;
    }
    if (now() - last.at < CPU_MIN_INTERVAL_MS) return usage;
    const current = sample();
    // A core going on or offline adds or drops its whole counters; keep the old value then.
    if (current.cores === last.cores && current.total > last.total) usage = percent(current.busy - last.busy, current.total - last.total);
    last = { at: now(), ...current };
    return usage;
  }
  async function disk(id: HostDisk['id'], label: string, target: string) {
    try {
      const [fs, info] = await Promise.all([statDisk(target), statPath(target)]);
      const total = fs.blocks * fs.bsize, available = fs.bavail * fs.bsize, used = (fs.blocks - fs.bfree) * fs.bsize;
      // Same base as df: the space ordinary users can still write.
      return { id, label, device: info.dev, sameFs: `${fs.blocks}:${fs.bfree}:${fs.bavail}`, totalBytes: total, availableBytes: available, usedBytes: used, usedPercent: percent(used, used + available) };
    } catch { return { id, label, device: null, sameFs: null, error: '无法读取' }; }
  }
  async function disks(): Promise<HostDisk[]> {
    const list = await Promise.all([...(dataDir ? [disk('data', '数据目录', dataDir)] : []), disk('root', '系统盘', '/')]);
    const data = list.find(item => item.id === 'data'), root = list.find(item => item.id === 'root');
    // Same device, or (btrfs subvolumes have their own st_dev) identical block counts.
    const same = data && root && !('error' in data) && !('error' in root) && (data.device === root.device || data.sameFs === root.sameFs);
    return (same ? [{ ...data, label: '数据目录（系统盘）' }] : list).map(({ device: _d, sameFs: _s, ...item }) => item);
  }
  let loopSince = now();
  function loopDelay(): HostStatus['process']['loopDelayMs'] {
    if (!loop || loop.count === 0) return null;
    const value = { mean: round(loop.mean / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) };
    if (now() - loopSince >= LOOP_WINDOW_MS) { loop.reset(); loopSince = now(); }
    return value;
  }
  async function read(): Promise<HostStatus> {
    const total = totalmem(), available = Math.min(freemem(), total);
    const [cpu, swap, diskList] = await Promise.all([cpuUsage(), readSwap(meminfo), disks()]);
    const memory = memoryUsage();
    return {
      generatedAt: now(),
      cpu: { usagePercent: cpu, cores, loadAverage: loadavg().map(value => round(value, 2)) },
      memory: { totalBytes: total, availableBytes: available, usedBytes: total - available, usedPercent: percent(total - available, total), swap },
      disks: diskList,
      uptimeSeconds: Math.floor(uptime()),
      process: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeSeconds: Math.floor(process.uptime()), loopDelayMs: loopDelay() },
    };
  }
  return { read };
}

/** The event-loop histogram for this process, started once. */
let sharedLoop: IntervalHistogram | null = null;
export function processLoopHistogram(): IntervalHistogram {
  if (!sharedLoop) { sharedLoop = monitorEventLoopDelay({ resolution: 20 }); sharedLoop.enable(); }
  return sharedLoop;
}
