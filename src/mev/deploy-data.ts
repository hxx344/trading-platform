// 执行合约的部署数据（docs/mev.md 第 6 节）：只做编码，不联网、不接触任何私钥。部署交易由用户用自己的冷钱包发出：
//   node src/mev/deploy-data.ts --owner <利润收款地址，冷钱包> --operator <热钱包地址>
// 输出的 data 作为一笔「to 为空」的交易的输入数据发到 Base 主网（链号 8453），例如
//   cast send --rpc-url <节点> --ledger --create <data>
// 部署出的合约地址填进 install.sh --set-mev 的 --mev-executor；模块启动时会把链上代码与本仓库的产物逐字节核对。
import { parseArgs } from 'node:util';
import { BASE_CHAIN_ID, FACTORIES } from './chain.ts';
import { abiEncode, isAddress, lower, type Hex } from './codec.ts';
import { EXECUTOR_CREATION_CODE, EXECUTOR_SOURCE_SHA256 } from './executor-artifact.ts';

/** 创建代码后接构造参数 (owner, operator, factories, kinds)；工厂表取 chain.ts 里登记的全部。 */
export function deploymentData(owner: string, operator: string): Hex {
  if (!isAddress(owner) || !isAddress(operator)) throw new TypeError('owner 与 operator 须为 0x 开头的 40 位十六进制地址');
  if (lower(owner) === lower(operator)) throw new TypeError('owner 与 operator 不能是同一个地址：owner 用冷钱包，operator 是专用热钱包');
  if (/^0x0{40}$/.test(owner)) throw new TypeError('owner 不能是零地址');
  const args = abiEncode(['address', 'address', { array: 'address' }, { array: 'uint' }],
    [lower(owner), lower(operator), FACTORIES.map(factory => factory.address), FACTORIES.map(factory => BigInt(factory.kind))]);
  return EXECUTOR_CREATION_CODE + args.slice(2);
}

function main(): void {
  const { values } = parseArgs({ options: { owner: { type: 'string' }, operator: { type: 'string' } } });
  if (values.owner === undefined || values.operator === undefined) throw new TypeError('用法：node src/mev/deploy-data.ts --owner <冷钱包地址> --operator <热钱包地址>');
  const data = deploymentData(values.owner, values.operator);
  process.stderr.write([
    `链：Base 主网（链号 ${BASE_CHAIN_ID}）；to 留空，value 为 0`,
    `owner（利润收款，可换热钱包、可取回合约里的代币）：${lower(values.owner)}`,
    `operator（热钱包，只能调用 execute）：${lower(values.operator)}`,
    `登记的工厂：${FACTORIES.length} 个；合约源码 sha256 ${EXECUTOR_SOURCE_SHA256}`,
    '下面一行是部署交易的 data：', '',
  ].join('\n'));
  process.stdout.write(`${data}\n`);
}

if (import.meta.main) { try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
