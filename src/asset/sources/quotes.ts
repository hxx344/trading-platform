// Copied from project_aggregation modules/asset/lib/exchanges.ts (Quote, coingeckoQuotes, quotes, usdPrice) at 0014655.
// Changes: split out of exchanges.ts; readJson/finite come from ./http.ts. Logic, sources and messages are unchanged.
import { finite, readJson, type Fetcher } from './http.ts';

export type Quote = { price: number; at: string; source: string };
export async function coingeckoQuotes(fetcher: Fetcher = fetch): Promise<Record<string, Quote>> {
  const data = await readJson('https://api.coingecko.com/api/v3/simple/price?ids=virtual-protocol,tether,usd-coin&vs_currencies=usd&include_last_updated_at=true', {}, fetcher);
  const result: Record<string, Quote> = {};
  for (const [symbol, id] of [['VIRTUAL','virtual-protocol'], ['USDT','tether'], ['USDC','usd-coin']]) {
    const item = data[id];
    const price = finite(item?.usd, symbol + ' 价格');
    const at = finite(item?.last_updated_at, symbol + ' 行情时间') * 1000;
    if (price <= 0 || Date.now()-at > 900000 || at-Date.now() > 60000) throw new Error('行情数据已过期，保留上次单价');
    result[symbol] = {price,at:new Date(at).toISOString(),source:'CoinGecko / USD'};
  }
  return result;
}
export async function quotes(fetcher:Fetcher=fetch):Promise<Record<string,Quote>>{
  try{return await coingeckoQuotes(fetcher);}catch(primaryError){
    try{
      const data=await readJson('https://api.coinbase.com/v2/exchange-rates?currency=USD',{},fetcher);
      if(data.data?.currency!=='USD')throw new Error('报价基础币种不是 USD');
      const result:Record<string,Quote>={};
      for(const coin of ['VIRTUAL','USDT','USDC']){
        const rate=finite(data.data.rates?.[coin],coin+' 兑换率');
        if(rate<=0)throw new Error('兑换率必须大于零');
        result[coin]={price:1/rate,at:new Date().toISOString(),source:'Coinbase / USD（获取时间）'};
      }
      return result;
    }catch{throw primaryError;}
  }
}
export async function usdPrice(coin: string, prices: Record<string, Quote>, fetcher: Fetcher = fetch): Promise<number> {
  if (coin === 'USD') return 1;
  if (prices[coin]) return prices[coin].price;
  if (!/^[A-Z0-9]{1,20}$/.test(coin) || !prices.USDT) throw new Error('暂不支持此币种的美元估值');
  const data = await readJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${coin}USDT`, {}, fetcher);
  if (data.retCode !== 0 || !data.result?.list?.[0]) throw new Error(`${coin} 缺少行情，本次账户同步未覆盖旧值`);
  const price = finite(data.result.list[0].lastPrice, coin + ' 价格');
  if (price <= 0) throw new Error('行情价格无效');
  return price * prices.USDT.price;
}
