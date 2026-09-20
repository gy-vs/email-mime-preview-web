import { describe, expect, it } from 'vitest';
import { RequestToken } from '../src/client/requestToken.js';

// Mirrors the App selection race guard: switching client profile before the
// previous response arrives must not allow the older preview to overwrite the
// current selection.
describe('RequestToken stale-response guard', () => {
  it('marks only the latest generation as current', () => {
    const guard = new RequestToken();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isStale(first)).toBe(true);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('simulated out-of-order responses: late earlier selection is dropped', async () => {
    const guard = new RequestToken();
    const profileARequest = guard.next();
    const profileBRequest = guard.next(); // user switched client quickly

    const rendered: string[] = [];
    async function respond(token: number, label: string, delay: number) {
      await new Promise((r) => setTimeout(r, delay));
      if (guard.isStale(token)) return; // this is what App.tsx does
      rendered.push(label);
    }
    // profile A was issued first but resolves *after* B
    await Promise.all([
      respond(profileARequest, 'A', 20),
      respond(profileBRequest, 'B', 5),
    ]);
    expect(rendered).toEqual(['B']);
  });
});
