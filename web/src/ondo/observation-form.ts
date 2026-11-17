export const OBSERVATION_CAPITAL_KEY = 'ondo-observation-capital-v1';

type SessionCapital = { startedAt: number; usd: number | null };
export type ObservationCapital = { input: string | null; session: SessionCapital | null };

export function capitalUsd(text: string): number | null {
  const value = Number(text);
  return text.length <= 24 && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(value) && value > 0 ? value : null;
}

export function readObservationCapital(raw: string | null): ObservationCapital {
  const empty = { input: null, session: null };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return empty;
    const input = typeof value.input === 'string' && capitalUsd(value.input) !== null ? value.input : null;
    const session = value.session;
    if (!session || !Number.isSafeInteger(session.startedAt) || session.startedAt <= 0
      || !(session.usd === null || (Number.isFinite(session.usd) && session.usd > 0))) return { input, session: null };
    return { input, session: { startedAt: session.startedAt, usd: session.usd } };
  } catch { return empty; }
}

/** A separate simple annual return for each market and distance. Zero and losses are valid observations. */
export function netAprPct(netDay: number | null | undefined, capital: number | null): number | null {
  if (netDay == null || !Number.isFinite(netDay) || capital === null || !Number.isFinite(capital) || capital <= 0) return null;
  const value = netDay / capital * 365 * 100;
  return Number.isFinite(value) ? value : null;
}
