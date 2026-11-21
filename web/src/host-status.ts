// The top bar's server load and connection badges (HostStatusBadge.tsx, ConnectionStatus.tsx). Both read /api/host
// every 3 s through one shared subscription; the round trip of that read is the browser-to-server latency. Levels and
// formats follow the workbench (project-aggregation src/server-status-types.ts and src/connection-quality.ts @ 52337a9).
import { api } from './api.ts';

export const HOST_PATH = '/api/host';
export const HOST_REFRESH_MS = 3_000;
export const HOST_TIMEOUT_MS = 5_000;

export type HostDisk = { id: 'data' | 'root'; label: string; error?: string; totalBytes?: number; availableBytes?: number; usedBytes?: number; usedPercent?: number | null };
export type ServiceConnection = { id: string; label: string; state: 'ok' | 'warn' | 'down' | 'unknown'; detail: string };
export type HostView = {
  generatedAt: number;
  cpu: { usagePercent: number | null; cores: number; loadAverage: number[] };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number | null; swap: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null };
  disks: HostDisk[];
  uptimeSeconds: number;
  process: { rssBytes: number; heapUsedBytes: number; uptimeSeconds: number; loopDelayMs: { mean: number; p99: number; max: number } | null };
  connections: ServiceConnection[];
  /** Measured here: from sending the read to its answer, in ms. */
  latencyMs: number;
};

/** Stable across renders, so every subscriber shares the one read. */
export async function readHost(signal: AbortSignal): Promise<HostView> {
  const started = performance.now();
  const view = await api<Omit<HostView, 'latencyMs'>>(HOST_PATH, { signal, timeoutMs: HOST_TIMEOUT_MS });
  return { ...view, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
}

export const hostLevel = (value: number | null | undefined): '' | 'warn' | 'alert' => value == null ? '' : value >= 90 ? 'alert' : value >= 75 ? 'warn' : '';
export const pct = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

/** The worst of CPU, memory and the fullest readable disk; what the phone width shows alone. */
export function hostWorst(view: HostView | null): { cpu: number | null; memory: number | null; disk: number | null; worst: number | null } {
  const disk = (view?.disks ?? []).reduce<number | null>((worst, item) => item.error || item.usedPercent == null ? worst : Math.max(worst ?? 0, item.usedPercent), null);
  const cpu = view?.cpu.usagePercent ?? null, memory = view?.memory.usedPercent ?? null;
  const worst = [cpu, memory, disk].reduce<number | null>((max, value) => value == null ? max : Math.max(max ?? 0, value), null);
  return { cpu, memory, disk, worst };
}

export type ConnectionQuality = 'checking' | 'good' | 'fair' | 'slow' | 'unreachable' | 'offline' | 'paused';
export const QUALITY_LABELS: Record<ConnectionQuality, string> = {
  checking: '检测中', good: '良好', fair: '一般', slow: '较慢', unreachable: '无法连接', offline: '本机离线', paused: '已暂停',
};

/**
 * The browser-to-server line: offline and paused come from the read's own state; a failed last read is unreachable even
 * with an older answer on screen; otherwise the latency of the last answer decides (good ≤150 ms, fair ≤500 ms).
 */
export function connectionQuality(status: 'loading' | 'ready' | 'error' | 'paused' | 'offline', latencyMs: number | null): ConnectionQuality {
  if (status === 'offline') return 'offline';
  if (status === 'paused') return 'paused';
  if (status === 'error') return 'unreachable';
  if (latencyMs === null) return 'checking';
  return latencyMs <= 150 ? 'good' : latencyMs <= 500 ? 'fair' : 'slow';
}

/** The service's own links folded into the badge's tone: any down is an error, any late or partial one a warning. */
export function servicesTone(connections: readonly ServiceConnection[]): '' | 'warn' | 'alert' {
  if (connections.some(item => item.state === 'down')) return 'alert';
  return connections.some(item => item.state === 'warn') ? 'warn' : '';
}
