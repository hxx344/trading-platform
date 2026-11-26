import type { PerpetualAlertConfig, PerpetualAlertEvent } from './perpetual-alerts.ts';

export interface PerpetualAlertState {
  version: 1; revision: number; config: PerpetualAlertConfig;
  ruleStates: Record<string, { armed: boolean; lastSentAt: number | null; lastAttemptAt: number | null }>;
  history: PerpetualAlertEvent[];
  deliveryReviews?: Record<string, NonNullable<PerpetualAlertEvent['reviews']>>;
}
export interface PerpetualAlertStore {
  get(): PerpetualAlertState;
  save(state: PerpetualAlertState): Promise<void>;
  pending?(): boolean;
  adoptPending?(): Promise<PerpetualAlertState | undefined>;
}
export const PERPETUAL_ALERT_FILE: 'opportunity-alerts.json';
export const PERPETUAL_ALERT_IMPORT: 'perpetual-alerts.import.json';
export function openPerpetualAlertStore(directory: string, pendingFile?: string): PerpetualAlertStore;
export function parsePerpetualAlertState(input: unknown): PerpetualAlertState;
