// 替身 EQN（docs/news.md）：本地预览用的 REST 与推送。主频道和四个异动频道各有几条样例，推送每 20 秒来一条新快讯，
// 随后 REST 也带上这条（模拟上游入库）。不连真实 eqn.news。
import type { NewsOptions, NewsSocket } from '../src/news/feed.ts';

type Raw = Record<string, unknown>;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function fakeNews(): NewsOptions {
  let next = 16_100;
  const pages: Record<string, Raw[]> = {
    main: [
      { no: 16_010, time: at(3), channels: ['main', 'binance'], source: 'Binance EN', zh: '币安将上线 Aerodrome (AERO) 永续合约，最高 75 倍杠杆', en: 'Binance Futures Will Launch USDⓈ-Margined AERO Perpetual Contract With Up to 75x Leverage', coins: ['AERO'], url: 'https://eqn.news/main/16010', source_url: 'https://www.binance.com/en/support/announcement', ai: { summary: { type: 'listing', points: [{ zh: '上线时间：今日 20:30（UTC+8）' }, { zh: '最高杠杆 75 倍，资金费结算间隔 4 小时' }] }, overview: { status: 'ready', zh: { paragraphs: [{ text: 'Aerodrome 是 Base 链上的主要 DEX，近期完成与 Velodrome 的代币合并。此前 Bybit 与 OKX 已上线 AERO 永续。', sources: [] }] } }, notice: 'AI 生成，仅供参考' } },
      { no: 15_920, time: at(95), channels: ['main', 'korea'], source: 'UPBIT LISTING', zh: 'StarkNet(STRK)、EigenCloud(EIGEN)、Request(REQ) 新增交易支持公告（BTC、USDT 市场）', en: null, coins: ['EIGEN', 'REQ', 'STRK'], url: 'https://eqn.news/main/15920', source_url: null, ai: null },
      { no: 15_782, time: at(26 * 60), channels: ['main'], source: 'AggrNews', zh: '永续合约DEX Variational以15亿美元估值完成1.1亿美元融资：彭博社', en: 'PERP DEX VARIATIONAL RAISES $110M AT $1.5B VALUATION: BBG', coins: [], url: 'https://eqn.news/main/15782', source_url: 'https://x.com/AggrNews', ai: null },
    ],
    pricechange: [
      { no: 16_002, time: at(8), channels: ['pricechange'], source: 'Price Monitor', zh: '现货价格监测：REQUSDT (REQ) 在过去 30 秒内上涨 9.2%。', en: 'SPOT Price Monitor: REQUSDT (REQ) +9.2% in the past 30 seconds', coins: ['SPOT', 'REQ'], url: 'https://eqn.news/monitor/16002', source_url: null, ai: null },
      { no: 15_983, time: at(150), channels: ['pricechange'], source: 'Price Monitor', zh: 'Bybit.P 监控：VELVETUSDT 在过去 10 秒内下跌了 8.5%，买价：0.07116，卖价：0.07117，最新价：0.07108。', en: 'Bybit.P Monitor: VELVETUSDT -8.5% in the past 10 seconds', coins: ['VELVET'], url: 'https://eqn.news/monitor/15983', source_url: null, ai: null },
    ],
    oi: [{ no: 15_951, time: at(240), channels: ['oi'], source: '价格与OI异动', zh: '🟢 [INITUSDT] 多头进场：币安未平仓合约量 +12.2%，过去 1 小时价格上涨 16.6%，未平仓合约量 1000 万美元，OI/市值 39.2%，24 小时 +17.4%', en: null, coins: ['INIT'], url: 'https://eqn.news/monitor/15951', source_url: null, ai: null }],
    major: [{ no: 15_940, time: at(300), channels: ['major'], source: 'Big Moves', zh: 'BTC 15 分钟内下跌 2.1%，现报 86,420 美元', en: null, coins: ['BTC'], url: 'https://eqn.news/monitor/15940', source_url: null, ai: null }],
    tfmoves: [{ no: 15_989, time: at(130), channels: ['tfmoves'], source: 'US Stocks', zh: '美股盘前：英伟达 (NVDA) 上涨 4.3%，财报超预期', en: null, coins: ['NVDA'], url: 'https://eqn.news/monitor/15989', source_url: null, ai: null }],
  };
  const fetchImpl = async (url: string) => {
    const channel = new URL(url).searchParams.get('channel') ?? 'main';
    return new Response(JSON.stringify({ items: pages[channel] ?? [], next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const connect = (): NewsSocket => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const emit = (type: string, event: unknown = {}) => { for (const listener of listeners[type] ?? []) listener(event); };
    let timer: ReturnType<typeof setInterval> | undefined;
    setTimeout(() => {
      emit('open');
      timer = setInterval(() => {
        const no = next++, title = `替身快讯 #${no}：某交易所将上线 DEMO${no % 7} 现货`;
        emit('message', { data: JSON.stringify({ source_name: 'Demo Listing', news_title: title, coins_included: [`DEMO${no % 7}`], url: `https://eqn.news/main/${no}`, timestamp: Math.floor(Date.now() / 1_000) }) });
        // 上游 5 秒后入库，页面上的「推送」标记随后一次 REST 核对消失。
        setTimeout(() => pages.main!.unshift({ no, time: new Date().toISOString(), channels: ['main'], source: 'Demo Listing', zh: title, en: `Demo listing #${no}`, coins: [`DEMO${no % 7}`], url: `https://eqn.news/main/${no}`, source_url: null, ai: null }), 5_000);
      }, 20_000);
    }, 300);
    return {
      addEventListener: (type: string, listener: (event: any) => void) => { (listeners[type] ??= []).push(listener); },
      send: (data: string) => { if (data === 'ping') setTimeout(() => emit('message', { data: 'pong' }), 50); },
      close: () => { clearInterval(timer); setTimeout(() => emit('close', { code: 1000 }), 0); },
    } as NewsSocket;
  };
  return { fetchImpl, connect, log: line => process.stdout.write(`[替身快讯] ${line}\n`) };
}
