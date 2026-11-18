import { isIP } from 'node:net';
import { integer } from '../contracts.ts';

export const DEFAULT_PORT = 4720;

/**
 * One specific address of this server, normalised as a URL writes it (so it matches the browser's Host header). The
 * wildcard addresses are refused: the page would then answer on every interface, the public one included.
 */
export function parseListenHost(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || isIP(value) === 0) throw new Error('host 须为本机的一个 IP 地址（例如 Tailscale 的 100.x.y.z），不能是域名');
  const v6 = isIP(value) === 6;
  const hostname = new URL(`http://${v6 ? `[${value}]` : value}/`).hostname;
  const normalised = v6 ? hostname.slice(1, -1) : hostname;
  if (/^0\./.test(normalised) || normalised === '::' || normalised === '::ffff:0:0' || normalised === '255.255.255.255') throw new Error('host 不能是 0.0.0.0、:: 等通配地址，须写本机的一个具体 IP');
  // 127.0.0.1 is always listened on: the same port again would never bind.
  if (/^127\./.test(normalised) || normalised === '::1' || /^::ffff:7f[0-9a-f]{2}:/.test(normalised)) throw new Error('host 不用写回环地址（总会监听 127.0.0.1），须写 Tailscale 等其它本机 IP');
  return normalised;
}
/** The listen address as written in a URL or a Host header. */
export const urlHost = (host: string): string => isIP(host) === 6 ? `[${host}]` : host;

export function parseListenConfig(value: { port?: unknown; host?: unknown }): { port: number; host: string | null } {
  const port = value.port === undefined ? DEFAULT_PORT : integer(value.port, 1_024, 65_535, '端口');
  return { port, host: parseListenHost(value.host) };
}
