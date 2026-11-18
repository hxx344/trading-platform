// Types for variational-market.mjs, gathered from its signatures.
import type { ExchangeQuote } from './exchange-comparison.mjs';

export type VariationalFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type VariationalPath = '/me' | '/quotes/indicative'
  | '/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future'
  | '/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future';
/** A failed request: `rejected` only for HTTP 401 with x-omni-auth: r on a request that carried a token. */
export interface VariationalError extends Error { rejected: boolean; blocked: boolean; status: number; variational: true }
export interface VariationalFunding { fundingRate: number; fundingIntervalHours: number; nextFundingAt: string }
export interface VariationalPublicFunding { left: VariationalFunding; right: VariationalFunding; fetchedAt: string }

export const VARIATIONAL_ORIGIN: string;
export const VARIATIONAL_STATS: string;
export const VARIATIONAL_USER_AGENT: string;
export const VARIATIONAL_EXPIRY_MARGIN_MS: number;
export const VARIATIONAL_PATHS: readonly VariationalPath[];
export function variationalTokenExpiry(token: unknown): number;
export function requestVariational(path: VariationalPath, token: string | null, options: { fetcher: VariationalFetcher; body?: unknown; signal?: AbortSignal }): Promise<unknown>;
export function variationalIndicativeBody(symbol: 'BZ' | 'CL'): { instrument: { underlying: 'BZ' | 'CL'; instrument_type: string; settlement_asset: string; kind: string }; qty: '1' };
export function parseVariationalMark(input: unknown, symbol: 'BZ' | 'CL', now?: number): { price: number; sourceTime: number };
export function parseVariationalFunding(input: unknown, now?: number): VariationalFunding;
export function readVariationalPublicFunding(options: { fetcher: VariationalFetcher; clock?: () => number; signal?: AbortSignal }): Promise<VariationalPublicFunding>;
export function variationalRequestError(error: unknown): VariationalError;
export function variationalReasonNote(reason: string): string;
/** `reason`: why the funding read failed (a fixed text), shown in the row's fundingError. */
export function withVariationalFunding(quote: ExchangeQuote, funding: VariationalPublicFunding | null, now?: number, reason?: string): ExchangeQuote;
export function readVariationalAuthenticatedMarks(token: string, options: { fetcher: VariationalFetcher; clock?: () => number; signal?: AbortSignal }): Promise<ExchangeQuote>;
export function parseVariationalOilQuote(input: unknown, receivedAt?: number): ExchangeQuote;
