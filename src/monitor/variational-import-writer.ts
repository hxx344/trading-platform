// The writing half of the workbench's Var token import (M-3d-2, docs/monitor.md), run by
// src/service/import-monitor-variational.ts as the owner of this service's data directory, never as root, with no environment:
//   node variational-import-writer.ts inspect --data-dir <dir>   what this service has now (no token in the output)
//   node variational-import-writer.ts write --data-dir <dir>     stdin: {"token": "..."}
// `write` checks the token again, decides against the file as it is now (decideVariationalImport) and, when it comes over,
// replaces monitor-variational-session.json (600, renamed into place, revision + 1); the running monitor takes it on its next
// read (variational-session.ts refresh). Output is one JSON line of revisions, expiries and reasons; errors never quote stdin.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDedicatedDataDir } from '../data-dir.ts';
import { VARIATIONAL_EXPIRY_MARGIN_MS, variationalTokenExpiry } from '../vendor/variational-market.mjs';
import { VARIATIONAL_SESSION_FILE, VARIATIONAL_SESSION_MAX_BYTES, readVariationalSessionFile, variationalFileIdentity, writeVariationalSessionFile } from './variational-session.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const iso = (ms: number): string => new Date(ms).toISOString();

/** This service's token as the import sees it: whether one is usable, until when, its revision, and why not. */
export interface ServiceVariational { configured: boolean; expiresAt: string | null; revision: number; problem: string | null }
export type VariationalDecision = { write: true; replaces: boolean } | { write: false; reason: string };

/** The file, when present, is a plain file of the service account (a link or someone else's file is not replaced). */
function assertOwnFile(file: string, uid = process.getuid?.()): void {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile()) throw new Error(`${file} 不是普通文件（符号链接等），未改动`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${file} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
}

function current(file: string, now: number): { view: ServiceVariational; token: string } {
  const { state, problem } = readVariationalSessionFile(file);
  if (problem) return { view: { configured: false, expiresAt: null, revision: state.revision, problem }, token: '' };
  if (!state.token) return { view: { configured: false, expiresAt: null, revision: 0, problem: null }, token: '' };
  const expiry = variationalTokenExpiry(state.token);
  return { view: { configured: true, expiresAt: iso(expiry), revision: state.revision, problem: expiry <= now + VARIATIONAL_EXPIRY_MARGIN_MS ? '本服务的 Var token 已过期' : null }, token: state.token };
}

/**
 * Whether the workbench's token replaces this service's: not when it is the same token, nor when this service's is still
 * good and declares an expiry no earlier (the page saved a newer one); otherwise it does.
 */
export function decideVariationalImport(service: ServiceVariational & { token?: string }, candidate: { token: string; expiry: number }): VariationalDecision {
  if (service.configured && service.token === candidate.token) return { write: false, reason: '本服务已是同一个 Var token' };
  if (service.configured && service.problem === null && service.expiresAt !== null && Date.parse(service.expiresAt) >= candidate.expiry) return { write: false, reason: `本服务的 Var token 声明到期 ${service.expiresAt}，不早于工作台的，保留本服务的` };
  return { write: true, replaces: service.configured };
}

export function inspectServiceVariational(dataDir: string, now = Date.now()): ServiceVariational {
  return current(join(dataDir, VARIATIONAL_SESSION_FILE), now).view;
}

/** Writes the token when it comes over; what was decided, and the revision and expiry now in the file. */
export async function writeImportedVariational(dataDir: string, input: unknown, now = Date.now): Promise<{ written: boolean; replaces: boolean; reason: string | null; revision: number; expiresAt: string }> {
  const token = (input as { token?: unknown } | null)?.token;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'token') || typeof token !== 'string') throw new Error('传入的内容不是 {"token": …}');
  let expiry: number;
  try { expiry = variationalTokenExpiry(token); } catch { throw new Error('传入的 Var token 格式无效'); }
  if (expiry <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) throw new Error('传入的 Var token 已过期或即将过期');
  const file = join(dataDir, VARIATIONAL_SESSION_FILE);
  assertOwnFile(file);
  // Read and decided against this version of the file; a save by the page after that makes the write give up (see
  // writeVariationalSessionFile), short of the instant between that check and the rename.
  const seen = variationalFileIdentity(file);
  const before = current(file, now());
  const decision = decideVariationalImport({ ...before.view, token: before.token }, { token, expiry });
  if (!decision.write) return { written: false, replaces: false, reason: decision.reason, revision: before.view.revision, expiresAt: before.view.expiresAt ?? iso(expiry) };
  const revision = before.view.revision + 1;
  await writeVariationalSessionFile(file, { version: 1, revision, token, updatedAt: iso(now()) }, seen);
  return { written: true, replaces: decision.replaces, reason: null, revision, expiresAt: iso(expiry) };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
  const command = positionals[0];
  if ((command !== 'write' && command !== 'inspect') || positionals.length !== 1 || !values['data-dir']) throw new Error('用法：inspect|write --data-dir <本服务数据目录的绝对路径>（write 的 token 从标准输入传入）');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  if (command === 'inspect') { process.stdout.write(JSON.stringify(inspectServiceVariational(dataDir))); return; }
  process.umask(0o077);
  const text = readFileSync(0);
  if (text.length > VARIATIONAL_SESSION_MAX_BYTES) throw new Error('传入的内容过大');
  let input: unknown;
  // The parser's message may quote the input: not passed on.
  try { input = JSON.parse(text.toString('utf8')); } catch { throw new Error('传入的内容不是有效的 JSON'); }
  process.stdout.write(JSON.stringify(await writeImportedVariational(dataDir, input)));
}

if (import.meta.main) { main().catch((error: unknown) => { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; }); }
