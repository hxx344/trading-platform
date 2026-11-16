// The online update's shapes (docs/update.md), apart from update.ts so the page can import them without Node modules.

export interface InstalledVersion {
  version: string;
  commit: string | null;
  /** False when there is no VERSION file (a development checkout): the version then comes from package.json. */
  packaged: boolean;
}

export interface ReleaseInfo { version: string; name: string; notes: string; publishedAt: string | null; url: string }

export interface UpdateRequest { id: string; version: string; at: number }

export type UpdatePhase = 'running' | 'done' | 'failed';

export interface UpdateResult {
  /** The request answered; null when the request file itself could not be used. */
  id: string | null;
  version: string | null;
  /** The version installed when the helper took the request. */
  from: string | null;
  startedAt: number;
  /** When the helper last wrote this file. */
  at: number;
  phase: UpdatePhase;
  /** download: fetching and checking install.sh; install: install.sh is running. */
  step?: 'download' | 'install';
  message: string;
  /** The last lines install.sh printed. */
  output: string[];
  /** The version installed when the helper finished. */
  installed?: string;
}

export interface UpdateView {
  current: InstalledVersion;
  latest: ReleaseInfo | null;
  /** When the last check succeeded. */
  checkedAt: number | null;
  checking: boolean;
  /** Why the last check failed; null after a success. */
  error: string | null;
  /** GitHub asked to wait until then (rate limit); no check, not even a manual one, goes out before. */
  retryAt: number | null;
  /** A manual check is refused before this time. */
  manualAt: number;
  available: boolean;
  /** The root helper is armed (install.sh wrote its marker); false: run the one-line install once on the server. */
  enabled: boolean;
  /** A request not yet taken by the helper; stale when it waited past UPDATE_REQUEST_STALE_MS. */
  pending: { id: string; version: string; at: number; stale: boolean } | null;
  job: (UpdateResult & { stale?: true }) | null;
  /** Why the hand-off directory could not be read. */
  jobError?: string;
}
