import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { parsePrivateJson, readPrivateFile } from '../live/setup.ts';
import { PASSWORD_FILE } from '../login-password.ts';

/** Hash the bytes and permissions of each descriptor the service actually reads, including an absent optional file. */
export function fingerprintReader() {
  const hash = createHash('sha256');
  const read = (path: string, name: string): string => {
    try {
      return readPrivateFile(path, name, (bytes, stat) => {
        hash.update(JSON.stringify([path, stat.mode, stat.uid, stat.gid, bytes.length]) + '\n');
        hash.update(bytes);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update(JSON.stringify([path, null]) + '\n');
      throw error;
    }
  };
  return { read, digest: () => hash.digest('hex') };
}

/** The same file order and private-file checks as the execution CLI, without parsing wallets or opening a database. */
export function configFingerprint(path: string): string {
  const files = fingerprintReader();
  const config = parsePrivateJson(files.read(path, '服务配置文件'), '服务配置文件') as { secretsFile?: unknown } | null;
  if (typeof config?.secretsFile !== 'string' || !isAbsolute(config.secretsFile)) throw new Error('secretsFile 必须是绝对路径');
  files.read(config.secretsFile, '密钥文件');
  try { files.read(join(dirname(path), PASSWORD_FILE), '登录密码文件'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return files.digest();
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3) throw new Error('需要服务配置文件的绝对路径');
    process.stdout.write(`${configFingerprint(path)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
