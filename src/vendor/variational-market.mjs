// 复制自 project-aggregation 工作台 modules/monitor（提交 8470785）：lib/variational-api.ts 的 token 到期解析与固定只读接口、
// 拒绝与拦截的区分（requestVariational），lib/variational-market.ts 的认证标记价与公开预测资金费解析，lib/oil-dex.ts 的
// parseVariationalOilQuote（公开 metadata/stats）。只放数据规则，服务端读取器（src/monitor/exchanges.ts）与会话
// （src/monitor/variational-session.ts）共用。与原文件不同的地方：
// - requestVariational 不再设 credentials / cache / AbortSignal.timeout（本服务只经 Python 传输脚本发请求，超时与中止由
//   调用方的 signal 与传输脚本负责），多接一个 signal；拒绝 / 拦截 / 缺 Python 的标记与中文原因不变，另加超时的原因，
//   错误上多带 blocked 与 variational（读取器据此原样给页面）；
// - readVariationalAuthenticatedMarks 的一腿失败时抛出该腿的原因（原文件统一为“认证标记行情暂不可用”），页面能看出是
//   被拦截、超时还是缺 Python；
// - withVariationalFunding 多一个 reason 参数：资金费读取失败的原因（固定文本，经 variationalReasonNote 去掉重复字样）
//   接在 fundingError 里；
// - 解析函数的错误文本统一以 “Var ” 开头（读取器按此原样给页面），合约不匹配等文本与原文件相同；
// - parseVariationalOilQuote 的公共辅助函数换成本文件内的同名实现（原文件与 Lighter 共用）。
import { validateExchangeQuote } from './exchange-comparison.mjs';

export const VARIATIONAL_ORIGIN = 'https://omni.variational.io';
export const VARIATIONAL_STATS = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
export const VARIATIONAL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 2_000_000;
const YEAR_SECONDS = 365 * 24 * 3600;
/** A token is treated as expired this long before its declared expiry. */
export const VARIATIONAL_EXPIRY_MARGIN_MS = 30_000;

/** The JWT's declared expiry in ms; throws the page's reason for anything that is not a single vr-token value. */
export function variationalTokenExpiry(token) {
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= 0 || claims.exp >= 253402300799) throw Error();
    return claims.exp * 1000;
  } catch { throw Error('Var token 格式无效，请仅粘贴 vr-token 的值。'); }
}

export const VARIATIONAL_PATHS = Object.freeze(['/me', '/quotes/indicative',
  '/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future',
  '/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future']);

/** Credentials only reach these fixed, read-only Variational endpoints. */
export async function requestVariational(path, token, { fetcher, body, signal } = {}) {
  // Keep the runtime allowlist as well as the TypeScript constraint.
  if (!VARIATIONAL_PATHS.includes(path)) throw Error('不支持的 Variational 数据接口。');
  if (token !== null) variationalTokenExpiry(token);
  else if (!path.startsWith('/funding/v2?')) throw Error('此 Variational 接口需要有效会话。');
  const post = path === '/quotes/indicative';
  try {
    const response = await fetcher(`${VARIATIONAL_ORIGIN}/api${path}`, {
      method: post ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(token ? { Cookie: `vr-token=${token}` } : {}), 'User-Agent': VARIATIONAL_USER_AGENT, Referer: `${VARIATIONAL_ORIGIN}/`, 'Cache-Control': 'no-cache', ...(post ? { 'Content-Type': 'application/json' } : {}) },
      ...(post ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', ...(signal ? { signal } : {}),
    });
    const challenged = response.headers.get('cf-mitigated') === 'challenge' || /text\/html/i.test(response.headers.get('content-type') || '');
    if (!response.ok || challenged) {
      await response.body?.cancel();
      // Official frontend B2Dt0Djp.js only treats 401 + x-omni-auth:r as
      // session rejection. A gateway challenge says nothing about the token.
      throw Object.assign(Error('Variational 数据请求失败。'), {
        rejected: token !== null && !challenged && response.status === 401 && response.headers.get('x-omni-auth') === 'r',
        blocked: challenged || response.status === 403,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw Error();
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    const rejected = Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);
    const blocked = Boolean(error && typeof error === 'object' && 'blocked' in error && error.blocked === true);
    const missingRuntime = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'VARIATIONAL_PYTHON_MISSING');
    const timedOut = Boolean(error && typeof error === 'object' && 'name' in error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
    throw Object.assign(Error(rejected ? 'Variational 未通过会话认证，请更新 token。' : blocked ? '服务器访问 Variational 被拦截，请稍后重试；这不代表 token 已过期。' : missingRuntime ? 'Variational 请求需要 Python 3，请重新运行一键部署或安装 Python 3。' : timedOut ? 'Variational 请求超时，请稍后重试。' : 'Variational 暂不可用，请稍后重试。'), { rejected, blocked, status: rejected ? 400 : 502, variational: true });
  }
}

const instrument = symbol => ({ underlying: symbol, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' });
export const variationalIndicativeBody = symbol => ({ instrument: instrument(symbol), qty: '1' });
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Var 行情响应格式无效。');
  return value;
};
const numeric = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) throw Error('Var 行情数值无效。');
  const result = Number(value);
  if (!Number.isFinite(result)) throw Error('Var 行情数值无效。');
  return result;
};
const stamp = value => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Var 行情时间无效。');
  return Date.parse(value);
};

/** The indicative response has a separate mark_price; bid/ask are never its substitute.
 * Protocol reused from variational-grid client.py / models.py, verified 2026-09-19.
 */
export function parseVariationalMark(input, symbol, now = Date.now()) {
  const value = object(input), receivedInstrument = object(value.instrument), expected = instrument(symbol);
  if (Object.keys(receivedInstrument).length !== Object.keys(expected).length || Object.entries(expected).some(([key, item]) => receivedInstrument[key] !== item) || numeric(value.qty) !== 1) throw Error('Var 原油合约或报价数量不匹配。');
  const price = numeric(value.mark_price), bid = numeric(value.bid), ask = numeric(value.ask), sourceTime = stamp(value.timestamp);
  if (price <= 0 || bid <= 0 || ask < bid) throw Error('Var 标记价格或报价无效。');
  if (sourceTime < now - 30_000 || sourceTime > now + 2_000) throw Error('Var 标记行情已过期。');
  return { price, sourceTime };
}

/** Official frontend, observed 2026-10-09:
 * https://omni.variational.io/_app/immutable/chunks/2OPCX0k9.js registers /funding/v2.
 * https://omni.variational.io/_app/immutable/chunks/VdRjQSXS.js constructs
 * {underlying, instrument_type}, and defines year seconds as 365*24*3600.
 * https://omni.variational.io/_app/immutable/chunks/D0i0EUnE.js transforms
 * predicted_funding_rate * funding_interval_s / yearSeconds for period display.
 * The raw rate is annualized decimal, not a percentage or an actual past payment.
 */
export function parseVariationalFunding(input, now = Date.now()) {
  const value = object(input), annualRate = numeric(value.predicted_funding_rate), intervalSeconds = numeric(value.funding_interval_s), next = stamp(value.next_funding_time);
  if (!Number.isInteger(intervalSeconds / 3600) || intervalSeconds < 3600 || intervalSeconds > 86_400 || next <= now || next > now + intervalSeconds * 1000 + 60_000) throw Error('Var 资金费周期或下次结算时间无效。');
  const fundingRate = annualRate * intervalSeconds / YEAR_SECONDS;
  if (!Number.isFinite(fundingRate) || Math.abs(fundingRate) > 1) throw Error('Var 预测资金费率无效。');
  return { fundingRate, fundingIntervalHours: intervalSeconds / 3600, nextFundingAt: new Date(next).toISOString() };
}

const isRejected = error => Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);

export async function readVariationalPublicFunding({ fetcher, clock = Date.now, signal } = {}) {
  // These endpoints are public. Never attach a saved token to a funding request.
  const values = await Promise.all(['BZ', 'CL'].map(symbol => requestVariational(`/funding/v2?underlying=${symbol}&instrument_type=perpetual_rwa_future`, null, { fetcher, signal })));
  const now = clock();
  return { left: parseVariationalFunding(values[0], now), right: parseVariationalFunding(values[1], now), fetchedAt: new Date(now).toISOString() };
}

/** A failure reason put in brackets after another text: without its full stop, its own retry advice and a leading “Var ”. */
export const variationalReasonNote = reason => reason ? `（${reason.replace(/^Var /, '').replace(/。$/, '').replace(/，请稍后重试$/, '')}）` : '';

export function withVariationalFunding(quote, funding, now = Date.now(), reason = '') {
  const valid = funding && [funding.left, funding.right].every(leg => Date.parse(leg.nextFundingAt) > now);
  return validateExchangeQuote({ ...quote,
    left: { ...quote.left, ...(valid ? funding.left : { fundingRate: null, nextFundingAt: null }) },
    right: { ...quote.right, ...(valid ? funding.right : { fundingRate: null, nextFundingAt: null }) },
    fundingFetchedAt: valid ? funding.fetchedAt : null,
    fundingError: valid ? '' : funding ? 'Var 预测结算时间已到，等待下一轮公开资金费更新。' : `Var 公开资金费暂不可用${variationalReasonNote(reason)}，后台将自动重试；无需更新 token。`,
  }, 'variational', 'oil');
}

export async function readVariationalAuthenticatedMarks(token, { fetcher, clock = Date.now, signal } = {}) {
  const results = await Promise.allSettled([
    requestVariational('/quotes/indicative', token, { fetcher, signal, body: variationalIndicativeBody('BZ') }),
    requestVariational('/quotes/indicative', token, { fetcher, signal, body: variationalIndicativeBody('CL') }),
  ]);
  if (results.some(result => result.status === 'rejected' && isRejected(result.reason))) throw Object.assign(Error('Variational 未通过会话认证，请更新 token。'), { rejected: true, variational: true });
  const [leftMark, rightMark] = results;
  if (leftMark.status !== 'fulfilled') throw leftMark.reason;
  if (rightMark.status !== 'fulfilled') throw rightMark.reason;
  const now = clock(), left = parseVariationalMark(leftMark.value, 'BZ', now), right = parseVariationalMark(rightMark.value, 'CL', now);
  if (Math.abs(left.sourceTime - right.sourceTime) > 15_000) throw Error('Var 原油双腿行情不同步。');
  const leg = (symbol, price) => ({ symbol, price,
    // For this monitor's explicit current estimate, weight rates by current marks.
    // This is not a statement about the venue's actual payment valuation basis.
    fundingPrice: price, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null });
  return validateExchangeQuote({ exchange: 'variational', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark',
    fetchedAt: new Date(Math.min(left.sourceTime, right.sourceTime)).toISOString(), timestampBasis: 'source',
    fundingFetchedAt: null, status: 'live', left: leg('BZ', left.price), right: leg('CL', right.price), fundingError: '',
  }, 'variational', 'oil');
}

// ---- public metadata/stats (lib/oil-dex.ts parseVariationalOilQuote) ----
const rows = value => { if (!Array.isArray(value)) throw Error('Var 合约目录格式无效。'); return value.map(object); };
const number = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = value => { const parsed = number(value); return parsed !== null && parsed > 0 ? parsed : null; };
function unique(items, key, symbol) {
  const matches = items.filter(row => row[key] === symbol);
  if (matches.length !== 1) throw Error(`Var 原油合约 ${symbol} 缺失或重复。`);
  return matches[0];
}

/** Public stats expose mark_price but no mark timestamp or next settlement.
 * quotes.updated_at timestamps cached RFQs, not mark_price. Funding's temporal
 * basis cannot be established from this API, so do not annualize funding_rate.
 * Prices are USDC: https://docs.variational.io/technical-documentation/api
 * CL/BZ futures identity: https://docs.variational.io/omni/trading/tradfi-perpetuals
 */
export function parseVariationalOilQuote(input, receivedAt = Date.now()) {
  const items = rows(object(input).listings);
  const leg = symbol => {
    const row = unique(items, 'ticker', symbol), price = positive(row.mark_price);
    if (price === null) throw Error(`Var ${symbol} 标记价格不可用。`);
    const intervalSeconds = number(row.funding_interval_s);
    const fundingIntervalHours = intervalSeconds !== null && intervalSeconds > 0 && intervalSeconds <= 86_400 && Number.isInteger(intervalSeconds / 3600) ? intervalSeconds / 3600 : null;
    return { symbol, price, fundingPrice: price, fundingRate: null, fundingIntervalHours, nextFundingAt: null };
  };
  return validateExchangeQuote({
    exchange: 'variational', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt: new Date(receivedAt).toISOString(), timestampBasis: 'received',
    fundingFetchedAt: null, status: 'live', left: leg('BZ'), right: leg('CL'),
    fundingError: '等待公开资金费更新；行情时间为本地接收时间。',
  }, 'variational', 'oil');
}
