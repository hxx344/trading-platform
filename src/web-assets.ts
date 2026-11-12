// The built service page (web/dist, from pnpm build:web), read once at start and kept in memory. The page is served
// under a CSP that allows no inline script or style, so a build that inlines either is refused here rather than
// shipped as a page that silently does nothing; so is anything that is not a plain file of a known kind.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebAsset { body: Buffer; type: string }
export interface WebApp { index: Buffer; assets: Map<string, WebAsset> }

/** Where the release keeps the build: web/dist next to src/, in the repository and in the installed package alike. */
export const WEB_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url));

const MAX_INDEX_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ASSETS = 64;
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2',
};

const plainFile = (path: string, what: string): number => {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`页面文件缺失：${what}（先运行 pnpm build:web）`); }
  if (!stat.isFile()) throw new Error(`页面文件不是普通文件：${what}`);
  return stat.size;
};

/**
 * Refuses an index.html the CSP would break: an inline script, a style element or attribute, an inline handler. A build
 * self-check against what Vite emits, not a security boundary: the CSP header is.
 */
export function checkIndexHtml(html: string): void {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) if (!/\ssrc=/i.test(tag)) throw new Error('页面 index.html 含内联脚本，CSP 不允许');
  if (/<style\b/i.test(html)) throw new Error('页面 index.html 含内联样式，CSP 不允许');
  if (/<[a-z][^>]*\s(style|on[a-z]+)\s*=/i.test(html)) throw new Error('页面 index.html 含内联样式属性或事件处理，CSP 不允许');
}

export function loadWebApp(dir: string = WEB_DIST): WebApp {
  const indexPath = join(dir, 'index.html');
  if (plainFile(indexPath, 'index.html') > MAX_INDEX_BYTES) throw new Error('页面 index.html 过大');
  const index = readFileSync(indexPath);
  checkIndexHtml(index.toString('utf8'));
  const assets = new Map<string, WebAsset>();
  const assetDir = join(dir, 'assets');
  let names: string[] = [];
  try { if (lstatSync(assetDir).isDirectory()) names = readdirSync(assetDir); else throw new Error('页面 assets 不是目录'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (names.length > MAX_ASSETS) throw new Error(`页面文件过多（${names.length} 个）`);
  let total = index.length;
  for (const name of names.sort()) {
    const dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1) : '';
    const type = Object.hasOwn(TYPES, extension) ? TYPES[extension] : undefined;
    if (!ASSET_NAME.test(name) || !type) throw new Error(`页面文件名或类型不受支持：assets/${name}`);
    const path = join(assetDir, name);
    const size = plainFile(path, `assets/${name}`);
    if (size > MAX_ASSET_BYTES) throw new Error(`页面文件过大：assets/${name}`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('页面文件合计过大');
    assets.set(name, { body: readFileSync(path), type });
  }
  // Every file the page names must be there, or it would load without its script or style.
  for (const [, name] of index.toString('utf8').matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) {
    if (!assets.has(name!)) throw new Error(`页面引用的文件缺失：assets/${name}`);
  }
  return { index, assets };
}
