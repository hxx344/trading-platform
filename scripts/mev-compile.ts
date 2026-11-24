// 用开发依赖 solc 编译 contracts/ 下的 Solidity（docs/mev.md）。`node scripts/mev-compile.ts` 重新生成
// src/mev/executor-artifact.ts；test/mev-contract.test.ts 用同一个函数核对入库产物与源码一致。运行时不依赖 solc。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const EXECUTOR_SOURCE = 'contracts/MevExecutor.sol';
export const MOCKS_SOURCE = 'contracts/test/Mocks.sol';
export const ARTIFACT_FILE = 'src/mev/executor-artifact.ts';

/** `immutables`：runtime 里各 immutable 所在的字节偏移（每处 32 字节，部署后填入实际值）。 */
export interface Compiled { creation: string; runtime: string; immutables: number[] }

/** 换行统一成 LF 再编译与取摘要，Windows 检出（CRLF）与 CI 得到同样的字节码。 */
export const readSource = (file: string): string => readFileSync(root + file, 'utf8').replace(/\r\n/g, '\n');
export const sourceHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export function compile(files: readonly string[]): Map<string, Compiled> {
  const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string };
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(files.map(file => [file, { content: readSource(file) }])),
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', metadata: { bytecodeHash: 'none', appendCBOR: false },
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> } } }>>;
  };
  const problems = (output.errors ?? []).filter(entry => entry.severity === 'error' || entry.severity === 'warning');
  if (problems.length) throw new Error(problems.map(entry => entry.formattedMessage).join('\n'));
  const compiled = new Map<string, Compiled>();
  for (const contracts of Object.values(output.contracts ?? {})) for (const [name, contract] of Object.entries(contracts)) {
    if (contract.evm.bytecode.object) compiled.set(name, { creation: '0x' + contract.evm.bytecode.object, runtime: '0x' + contract.evm.deployedBytecode.object,
      immutables: Object.values(contract.evm.deployedBytecode.immutableReferences ?? {}).flat().map(entry => entry.start).sort((a, b) => a - b) });
  }
  return compiled;
}

export function renderArtifact(): string {
  const executor = compile([EXECUTOR_SOURCE]).get('MevExecutor');
  if (!executor) throw new Error('编译结果里没有 MevExecutor');
  return `// 由 scripts/mev-compile.ts 从 ${EXECUTOR_SOURCE} 生成（solc 0.8.30，optimizer 200，cancun，不带元数据），不要手改。
// test/mev-contract.test.ts 核对它与源码一致。runtime 里 owner 是 immutable，部署后的代码在 EXECUTOR_OWNER_OFFSETS 处填入 owner 地址。
export const EXECUTOR_SOURCE_SHA256 = '${sourceHash(readSource(EXECUTOR_SOURCE))}';
export const EXECUTOR_CREATION_CODE = '${executor.creation}';
export const EXECUTOR_RUNTIME_CODE = '${executor.runtime}';
export const EXECUTOR_OWNER_OFFSETS: readonly number[] = [${executor.immutables.join(', ')}];
`;
}

if (import.meta.main) {
  writeFileSync(root + ARTIFACT_FILE, renderArtifact());
  process.stdout.write(`已写入 ${ARTIFACT_FILE}\n`);
}
