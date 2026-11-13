// Copied from project_aggregation modules/asset/lib/exchanges.ts (Aster: AsterCredential, nextAsterNonce, validateAsterWallet,
// asterGet, syncAster) at 0014655.
// Changes: ethers' Wallet and signTypedData are replaced by this repository's dependency-free src/aster/eip712.ts
// (addressOf, signAsterMessage: the same EIP-712 domain AsterSignTransaction / "1" / 1666 / zero verifying contract and
// type Message{msg:string}; test/asset-sources-aster.test.ts checks the signature byte for byte against ethers).
// validateAsterWallet therefore returns { address, privateKey } instead of an ethers Wallet; address is EIP-55 checksummed
// like Wallet.address. The nonce allocator is this module's own, as in the workbench: src/aster/client.ts keeps its
// sequence as a private member of each AsterClient, which a read layer without that instance cannot share.
// Hosts, read-only paths, query layout, messages and the 12 s timeout (./http.ts readJson) are unchanged.
import type { Balance } from '../types.ts';
import { addressOf, keccak256, signAsterMessage } from '../../aster/eip712.ts';
import { finite, readJson, type Fetcher, type Json } from './http.ts';
import { usdPrice, type Quote } from './quotes.ts';

export type AsterCredential={walletAddress:string;privateKey:string;includeSpot:boolean};
export type AsterWallet={address:string;privateKey:string};
const ASTER_READ_HOSTS={
  '/fapi/v3/accountWithJoinMargin':'https://fapi.asterdex.com',
  '/api/v3/account':'https://sapi.asterdex.com',
} as const;
type AsterReadPath=keyof typeof ASTER_READ_HOSTS;
let lastAsterNonce=0;
// Balance and position readers share one nonce allocator so concurrent reads of
// the same API Pro wallet cannot reuse the same microsecond timestamp.
export function nextAsterNonce(){lastAsterNonce=Math.max(Date.now()*1000,lastAsterNonce+1);return String(lastAsterNonce);}
/** EIP-55 mixed-case form of a lower-case 0x address, as ethers' Wallet.address reports it. */
function checksumAddress(address:string):string{
  const body=address.slice(2),hash=Buffer.from(keccak256(Buffer.from(body,'ascii'))).toString('hex');
  let out='0x';
  for(let i=0;i<body.length;i++)out+=parseInt(hash[i]!,16)>=8?body[i]!.toUpperCase():body[i]!;
  return out;
}
export function validateAsterWallet(c:AsterCredential):AsterWallet{
  if(!c.walletAddress||!c.privateKey)throw new Error('Aster 连接需要更新：请填写 API Pro 钱包地址和对应私钥；已保留旧估值');
  const privateKey=c.privateKey.startsWith('0x')?c.privateKey:'0x'+c.privateKey;
  let address:string;
  try{address=checksumAddress(addressOf(privateKey));}
  catch{throw new Error('API 钱包私钥无效，请检查是否为 64 位十六进制私钥');}
  if(address.toLowerCase()!==c.walletAddress.toLowerCase())throw new Error('API 钱包地址与私钥不匹配，请使用同一个 API 钱包的地址和私钥');
  return {address,privateKey};
}
export async function asterGet(c:AsterCredential,path:AsterReadPath,fetcher:Fetcher=fetch):Promise<Json>{
  if(!Object.hasOwn(ASTER_READ_HOSTS,path))throw new Error('仅支持 Aster 只读余额接口');
  const wallet=validateAsterWallet(c);
  // Sign precisely the encoded query sent to Aster. Private keys never leave this server.
  const query=new URLSearchParams({nonce:nextAsterNonce(),signer:wallet.address}).toString();
  let signature:string;
  try{signature=signAsterMessage(query,wallet.privateKey);}
  catch{throw new Error('API 钱包签名失败，请检查钱包配置');}
  const data=await readJson(ASTER_READ_HOSTS[path]+path+'?'+query+'&signature='+signature,{method:'GET'},fetcher);
  if(typeof data.code==='number'&&data.code<0)throw new Error(`Aster 读取失败（${data.code}），请检查 API Pro 钱包授权和服务器时间`);
  return data;
}
export async function syncAster(c:AsterCredential,prices:Record<string,Quote>,fetcher:Fetcher=fetch):Promise<{total:number;details:Balance[]}>{
  const [account,spot]=await Promise.all([asterGet(c,'/fapi/v3/accountWithJoinMargin',fetcher),c.includeSpot?asterGet(c,'/api/v3/account',fetcher):null]);
  if(!Array.isArray(account.assets)||(spot&&!Array.isArray(spot.balances)))throw new Error('Aster 账户数据不完整，本次不覆盖旧值');
  const details:Balance[]=await Promise.all(account.assets.map(async(a:Json)=>{
    // marginBalance already includes unrealized P&L, including isolated positions.
    const quantity=finite(a.marginBalance,'Aster 币种净权益');
    const price=quantity===0?0:await usdPrice(String(a.asset),prices,fetcher);
    return {coin:String(a.asset),account:'合约净权益（含未实现盈亏）',quantity,price,value:quantity*price};
  }));
  if(spot){details.push(...await Promise.all(spot.balances.map(async(a:Json)=>{
    const quantity=finite(a.free,'现货可用余额')+finite(a.locked,'现货冻结余额');
    const price=quantity===0?0:await usdPrice(String(a.asset),prices,fetcher);
    return {coin:String(a.asset),account:'现货钱包',quantity,price,value:quantity*price};
  })));}
  return {total:details.reduce((s,a)=>s+a.value,0),details:details.filter(a=>a.quantity!==0)};
}
