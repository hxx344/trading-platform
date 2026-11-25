import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The installer owns release directories. A checkout can run the services without building a package. */
export function readComponentBuild(root: string, component: 'executor' | 'control' | 'market' | 'dex'): string {
  const file = join(root, `.${component}-sha256`);
  try {
    const digest = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(digest)) return digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(join(root, '.package-sha256'))) return 'development';
    throw error;
  }
  throw new Error(`${file} 中的组件校验和无效`);
}
