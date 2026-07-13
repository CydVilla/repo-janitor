import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSleepForTests, checkLinks } from '../src/link-checker/check.js';
import type { LinkCheckOutcome } from '../src/types.js';

/** Build a Response with a given status and (optionally) a final URL. */
function res(status: number, finalUrl?: string): Response {
  const response = new Response(null, { status });
  if (finalUrl !== undefined) {
    Object.defineProperty(response, 'url', { value: finalUrl });
  }
  return response;
}

interface RecordedCall {
  method: string;
  url: string;
}

function callLabel(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): RecordedCall {
  return { method: init?.method ?? 'GET', url: String(input) };
}

function only(outcomes: LinkCheckOutcome[]): LinkCheckOutcome {
  expect(outcomes).toHaveLength(1);
  return outcomes[0] as LinkCheckOutcome;
}

let sleeps: number[] = [];

beforeEach(() => {
  sleeps = [];
  // Skip real politeness/backoff delays; record what would have been slept.
  __setSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  __setSleepForTests();
});

describe('checkLinks', () => {
  it('marks a 200 HEAD response ok', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      return res(200);
    };

    const outcome = only(await checkLinks(['https://ok.test/page'], { fetchImpl }));

    expect(outcome.ok).toBe(true);
    expect(outcome.url).toBe('https://ok.test/page');
    expect(outcome.statusCode).toBe(200);
    expect(outcome.error).toBeUndefined();
    expect(outcome.redirectedTo).toBeUndefined();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(outcome.checkedAt).toISOString()).toBe(outcome.checkedAt);
    expect(calls).toEqual([{ method: 'HEAD', url: 'https://ok.test/page' }]);
  });

  it('fails a 404 immediately without retrying', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      return res(404);
    };

    const outcome = only(await checkLinks(['https://gone.test/x'], { fetchImpl }));

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(404);
    expect(outcome.error).toBeUndefined();
    expect(calls).toEqual([{ method: 'HEAD', url: 'https://gone.test/x' }]);
    expect(sleeps).toEqual([]); // no backoff for a permanent failure
  });

  it('treats 429 as ok (host alive, rate limiting)', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      return res(429);
    };

    const outcome = only(await checkLinks(['https://busy.test/'], { fetchImpl }));

    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(429);
    expect(calls.map((c) => c.method)).toEqual(['HEAD']); // no GET fallback, no retry
  });

  for (const headStatus of [403, 405, 501]) {
    it(`falls back to GET when HEAD returns ${headStatus}`, async () => {
      const calls: RecordedCall[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        calls.push(callLabel(input, init));
        return init?.method === 'HEAD' ? res(headStatus) : res(200);
      };

      const outcome = only(await checkLinks(['https://no-head.test/doc'], { fetchImpl }));

      expect(outcome.ok).toBe(true);
      expect(outcome.statusCode).toBe(200);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    });
  }

  it('falls back to GET when HEAD throws, and uses the GET result', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      if (init?.method === 'HEAD') throw new TypeError('fetch failed');
      return res(200);
    };

    const outcome = only(await checkLinks(['https://head-hostile.test/'], { fetchImpl }));

    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('fails immediately when the GET fallback returns a non-429 4xx', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      return init?.method === 'HEAD' ? res(405) : res(404);
    };

    const outcome = only(await checkLinks(['https://no-head.test/gone'], { fetchImpl }));

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(404);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect(sleeps).toEqual([]);
  });

  it('retries a 500 with exponential backoff, then fails', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      return res(500);
    };

    const outcome = only(
      await checkLinks(['https://flaky.test/'], { fetchImpl, retries: 2 }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(500);
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD', 'HEAD']);
    expect(sleeps).toEqual([500, 1000]); // exponential from the 500ms base
  });

  it('retries network errors, then fails with the error message', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(callLabel(input, init));
      throw new TypeError('fetch failed');
    };

    const outcome = only(
      await checkLinks(['https://down.test/'], { fetchImpl, retries: 1 }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeUndefined();
    expect(outcome.error).toBe('fetch failed');
    // Each attempt is HEAD (throws) then the GET fallback (throws).
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET', 'HEAD', 'GET']);
    expect(sleeps).toEqual([500]);
  });

  it('times out via AbortSignal and reports the timeout', async () => {
    let sawSignal = false;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('expected an AbortSignal');
        sawSignal = true;
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });

    const outcome = only(
      await checkLinks(['https://slow.test/'], { fetchImpl, timeoutMs: 15, retries: 0 }),
    );

    expect(sawSignal).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeUndefined();
    expect(outcome.error).toBe('timed out after 15ms');
  });

  it('records redirectedTo when the final URL differs, ignoring pure normalization', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://move.test/old') return res(200, 'https://move.test/new');
      return res(200, 'https://plain.test/');
    };

    const outcomes = await checkLinks(
      ['https://move.test/old', 'https://plain.test'],
      { fetchImpl },
    );

    expect(outcomes.map((o) => o.url)).toEqual([
      'https://move.test/old',
      'https://plain.test',
    ]);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.redirectedTo).toBe('https://move.test/new');
    // https://plain.test -> https://plain.test/ is normalization, not a redirect.
    expect(outcomes[1]?.ok).toBe(true);
    expect(outcomes[1]?.redirectedTo).toBeUndefined();
  });

  it('serializes same-host URLs (with politeness delay) while other hosts proceed', async () => {
    const calls: string[] = [];
    let releaseA1!: () => void;
    const gateA1 = new Promise<void>((resolve) => {
      releaseA1 = resolve;
    });

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method} ${url}`);
      if (url === 'https://a.test/1') await gateA1;
      return res(200);
    };

    const pending = checkLinks(
      ['https://a.test/1', 'https://a.test/2', 'https://b.test/1'],
      { fetchImpl },
    );

    // While a.test/1 is in flight, b.test/1 runs but a.test/2 must wait.
    await vi.waitFor(() => {
      expect(calls).toContain('HEAD https://b.test/1');
    });
    expect(calls).toEqual(['HEAD https://a.test/1', 'HEAD https://b.test/1']);

    releaseA1();
    const outcomes = await pending;

    expect(calls).toEqual([
      'HEAD https://a.test/1',
      'HEAD https://b.test/1',
      'HEAD https://a.test/2',
    ]);
    expect(sleeps).toContain(250); // politeness delay between same-host requests
    expect(outcomes.map((o) => o.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://b.test/1',
    ]); // results keep input order
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it('never throws for an unparseable URL', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch must not be called for invalid URLs');
    };

    const outcome = only(await checkLinks(['not a url'], { fetchImpl }));

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('invalid URL');
    expect(outcome.statusCode).toBeUndefined();
  });

  it('returns an empty array for no URLs', async () => {
    await expect(checkLinks([])).resolves.toEqual([]);
  });
});
