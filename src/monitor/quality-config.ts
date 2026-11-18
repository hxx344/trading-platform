/**
 * M-5d2: the quality service's optional CoinGecko settings, as the workbench reads them (monitor-services.mjs):
 * PERPETUAL_COIN_IDS, a JSON object of base to CoinGecko id (at most 2000), and COINGECKO_DEMO_API_KEY. The workbench refuses to
 * start on an invalid PERPETUAL_COIN_IDS; here it is ignored with a log line (the built-in ids still apply). Values never logged.
 */
export function perpetualQualityEnv(env: Record<string, string | undefined>, log: (line: string) => void): { coinIds?: Record<string, string>; apiKey?: string } {
  let coinIds: Record<string, string> | undefined;
  if (env.PERPETUAL_COIN_IDS) {
    try {
      const value: unknown = JSON.parse(env.PERPETUAL_COIN_IDS);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2000
        || Object.entries(value).some(([base, id]) => !/^[A-Z0-9._-]{1,40}$/.test(base) || typeof id !== 'string' || !/^[a-z0-9-]{1,120}$/.test(id))) throw new Error();
      coinIds = value as Record<string, string>;
    } catch { log('PERPETUAL_COIN_IDS 必须为币种到 CoinGecko ID 的 JSON 对象，已忽略，只用内置的币种映射'); }
  }
  return { ...(coinIds ? { coinIds } : {}), ...(env.COINGECKO_DEMO_API_KEY ? { apiKey: env.COINGECKO_DEMO_API_KEY } : {}) };
}
