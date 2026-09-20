// Monotonic token guard for in-flight requests.
//
// The selection view changes whenever the message or the simulated client
// profile changes. Responses may arrive out of order (or an earlier request
// may simply be slow); callers must ignore any response whose token is no
// longer the latest one so a stale preview can never overwrite the current
// selection.
export class RequestToken {
  private current = 0;

  /** Begin a new generation; older responses become stale. */
  next(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(token: number): boolean {
    return token === this.current;
  }

  isStale(token: number): boolean {
    return token !== this.current;
  }
}
