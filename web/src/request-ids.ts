// Request ids for writes. A retry keeps the id until an answer arrives, so the server can return the first outcome
// for a request whose response was lost; any answer, a refusal included, ends that request. A changed input is a
// different request and gets a new id.

// crypto.randomUUID exists only on HTTPS or localhost; the page is also opened over plain http on a Tailscale address.
export function newRequestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 15) | 64; b[8] = (b[8]! & 63) | 128;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class RequestIds {
  private readonly saved = new Map<string, { input: string; requestId: string }>();
  private readonly make: () => string;
  constructor(make: () => string = newRequestId) { this.make = make; }
  /** The id for this action and input: the pending one while no answer came back, a new one otherwise. */
  idFor(key: string, input = ''): string {
    const saved = this.saved.get(key);
    if (saved && saved.input === input) return saved.requestId;
    const requestId = this.make();
    this.saved.set(key, { input, requestId });
    return requestId;
  }
  /** An answer arrived (success or a refusal): the next attempt is a new request. */
  answered(key: string): void { this.saved.delete(key); }
  /** Runs one write: an error with an HTTP status is an answer; one without (network, timeout) keeps the id for the retry.
   * `settles` narrows which errors count as an answer, for a write whose earlier attempt may still be unanswered. */
  async run<T>(key: string, input: string, send: (requestId: string) => Promise<T>, settles: (error: unknown) => boolean = hasStatus): Promise<T> {
    try {
      const result = await send(this.idFor(key, input));
      this.answered(key);
      return result;
    } catch (error) {
      if (settles(error)) this.answered(key);
      throw error;
    }
  }
}

const hasStatus = (error: unknown): boolean => typeof (error as { status?: unknown } | null)?.status === 'number';
