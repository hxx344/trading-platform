import type { PerpetualAlertView } from './perpetual-alerts.ts';
import type { PerpetualAlertStore } from './perpetual-alert-store.mjs';
import type { PerpetualQuote } from './perpetual-stream.mjs';

export interface OpportunityNotifications {
  configured(): boolean;
  send(text: string, beforeSend: () => void): Promise<void>;
}
export function createPerpetualAlertService(options: {
  store?: PerpetualAlertStore; notifications?: OpportunityNotifications; clock?: () => number;
  getQuote: (key: string) => PerpetualQuote | undefined; isVenueLive: (id: string) => boolean;
  unavailableReason?: string; onImportError?: (reason: string) => void;
}): {
  start(): void; stop(): Promise<void>; check(): Promise<void>;
  view(): PerpetualAlertView; update(input: unknown): Promise<PerpetualAlertView>; review(input: unknown): Promise<PerpetualAlertView>;
};
