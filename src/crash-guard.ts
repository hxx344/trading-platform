// The last word of a process that dies on an error nobody caught. Node already exits on an uncaught exception and on an
// unhandled promise rejection; this keeps that, but first writes one readable line to stderr (the journal and the page's
// log tab) and, for the trading service, a marker in its data directory. The next start turns the marker into a Feishu
// alert, since a crash skips the stop alert and systemd's restart alone only says 【服务启动】.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CRASH_FILE = 'last-crash.json';

export interface CrashRecord {
  at: number;
  process: string;
  kind: 'uncaughtException' | 'unhandledRejection';
  message: string;
  /** The first frames of the stack, at most a few lines. */
  stack: string;
}

const KIND_TEXT: Record<CrashRecord['kind'], string> = { uncaughtException: '未捕获的异常', unhandledRejection: '未处理的 Promise 拒绝' };

export function describeCrash(reason: unknown, kind: CrashRecord['kind'], name: string, at: number): CrashRecord {
  const error = reason instanceof Error ? reason : null;
  const message = (error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(reason)).slice(0, 300);
  const stack = (error?.stack ?? '').split('\n').slice(1, 7).map(line => line.trim()).filter(Boolean).join('\n').slice(0, 1_200);
  return { at, process: name, kind, message, stack };
}

export function crashLine(record: CrashRecord): string {
  return `【${record.process}异常退出】${KIND_TEXT[record.kind]}：${record.message}${record.stack ? `\n${record.stack}` : ''}`;
}

export interface CrashGuardOptions {
  /** Where the marker goes; without it only the line is written. */
  dir?: string;
  log?: (line: string) => void;
  exit?: (code: number) => void;
  now?: () => number;
  /** Where the two events come from; the process itself outside tests. */
  source?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
}

/** Registers the two handlers; returns their removal (tests). The first crash wins, later ones only exit. */
export function installCrashGuard(name: string, { dir, log = line => process.stderr.write(`${line}\n`), exit = code => process.exit(code), now = Date.now, source = process }: CrashGuardOptions = {}): () => void {
  let crashed = false;
  const handler = (kind: CrashRecord['kind']) => (reason: unknown) => {
    if (crashed) { exit(1); return; }
    crashed = true;
    const record = describeCrash(reason, kind, name, now());
    try { log(crashLine(record)); } catch { /* stderr gone: the marker still says it */ }
    if (dir) {
      const temp = join(dir, `.${CRASH_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      try { writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temp, join(dir, CRASH_FILE)); }
      catch { try { rmSync(temp, { force: true }); } catch { /* nothing more to do */ } }
    }
    exit(1);
  };
  const onException = handler('uncaughtException'), onRejection = handler('unhandledRejection');
  source.on('uncaughtException', onException);
  source.on('unhandledRejection', onRejection);
  return () => { source.off('uncaughtException', onException); source.off('unhandledRejection', onRejection); };
}

/**
 * The marker a crashed run left, kept until clearCrashRecord(): the caller removes it only once the report is queued, so
 * a start whose notifier fails reports it on the next start. Null when there is none; an unreadable one is removed.
 */
export function readCrashRecord(dir: string): CrashRecord | null {
  const path = join(dir, CRASH_FILE);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const unreadable = () => { clearCrashRecord(dir); return null; };
  try {
    const value = JSON.parse(text) as Partial<CrashRecord>;
    if (typeof value.at !== 'number' || typeof value.process !== 'string' || typeof value.message !== 'string'
      || (value.kind !== 'uncaughtException' && value.kind !== 'unhandledRejection')) return unreadable();
    return { at: value.at, process: value.process.slice(0, 40), kind: value.kind, message: value.message.slice(0, 300), stack: typeof value.stack === 'string' ? value.stack.slice(0, 1_200) : '' };
  } catch { return unreadable(); }
}

/** Removes the marker once its report is queued; a failure leaves it for the next start (whose report is keyed, crashReportKey). */
export function clearCrashRecord(dir: string): void {
  try { rmSync(join(dir, CRASH_FILE), { force: true }); } catch { /* reported to the notifier again next start, which drops it by key */ }
}

/** The once-key of a crash report: the same marker read on two starts is queued once. */
export const crashReportKey = (record: CrashRecord) => `crash:${record.process}:${record.at}`;
