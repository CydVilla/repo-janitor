import type { LinkCheckOutcome } from '../types.js';

export interface CheckOptions {
  /** Max concurrent requests overall (default 8). */
  concurrency?: number;
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Retries for network errors / 5xx (default 2, with backoff). */
  retries?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_USER_AGENT = 'repo-janitor/0.1 (link health check)';
/** Base for exponential retry backoff: 500ms, 1s, 2s, ... */
const BACKOFF_BASE_MS = 500;
/** Pause between consecutive requests to the same host (politeness). */
const POLITENESS_DELAY_MS = 250;
/** HEAD responses that mean "retry with GET" rather than "dead link". */
const HEAD_FALLBACK_STATUSES = new Set([403, 405, 501]);

type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injection point so tests can skip politeness/backoff delays. */
let sleep: SleepFn = realSleep;

/**
 * Test-only: replace the delay used for politeness spacing and retry backoff.
 * Call with no argument to restore the real timer. Does not affect the
 * AbortSignal-based per-request timeout.
 * @internal
 */
export function __setSleepForTests(impl?: SleepFn): void {
  sleep = impl ?? realSleep;
}

interface ResolvedOptions {
  timeoutMs: number;
  retries: number;
  fetchImpl: typeof fetch;
  userAgent: string;
}

/**
 * Check liveness of URLs.
 *
 * Behavior contract:
 * - HEAD first; fall back to GET when HEAD returns 405/403/501 or throws.
 * - Follows redirects; 2xx (and 429 — host is alive, just rate-limiting us)
 *   count as ok. Other 4xx count as failures immediately; 5xx / timeouts /
 *   network errors count as failures only after retries are exhausted.
 * - Records the final URL in `redirectedTo` when a permanent redirect (301/308)
 *   moved the URL elsewhere.
 * - Requests to the same host are serialized with a small delay (politeness);
 *   different hosts run concurrently up to `concurrency`.
 * - Never throws for an individual URL; failures are captured in the outcome.
 */
export async function checkLinks(
  urls: string[],
  options: CheckOptions = {},
): Promise<LinkCheckOutcome[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const resolved: ResolvedOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    fetchImpl: options.fetchImpl ?? fetch,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  };

  const results: LinkCheckOutcome[] = new Array<LinkCheckOutcome>(urls.length);

  // Group input indices by host so each host's URLs run strictly in order.
  const hostQueues = new Map<string, number[]>();
  for (const [index, url] of urls.entries()) {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      results[index] = {
        url,
        ok: false,
        error: 'invalid URL',
        durationMs: 0,
        checkedAt: new Date().toISOString(),
      };
      continue;
    }
    const queue = hostQueues.get(host);
    if (queue) queue.push(index);
    else hostQueues.set(host, [index]);
  }

  const queues = [...hostQueues.values()];
  let nextQueue = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const queue = queues[nextQueue];
      nextQueue += 1;
      if (!queue) return;
      for (const [position, index] of queue.entries()) {
        if (position > 0) await sleep(POLITENESS_DELAY_MS);
        results[index] = await checkOne(urls[index] as string, resolved);
      }
    }
  };

  const workerCount = Math.min(concurrency, queues.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Check a single URL, retrying transient failures. Never throws. */
async function checkOne(url: string, opts: ResolvedOptions): Promise<LinkCheckOutcome> {
  const started = Date.now();
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await requestWithFallback(url, opts);
    } catch (err) {
      // Network error / timeout on both HEAD and GET: transient, retryable.
      lastError = describeError(err, opts.timeoutMs);
      lastStatus = undefined;
      continue;
    }

    const status = response.status;
    const redirectedTo = redirectTarget(url, response);

    if ((status >= 200 && status < 300) || status === 429) {
      return buildOutcome(url, true, started, { statusCode: status, redirectedTo });
    }
    if (status >= 500) {
      // Server error: transient, retryable.
      lastStatus = status;
      lastError = undefined;
      continue;
    }
    // Remaining 4xx (and anything else unexpected): fail immediately.
    return buildOutcome(url, false, started, { statusCode: status, redirectedTo });
  }

  return buildOutcome(url, false, started, { statusCode: lastStatus, error: lastError });
}

/**
 * One attempt: HEAD first, falling back to GET when the server rejects HEAD
 * (405/403/501) or the HEAD request throws. Throws (network error / timeout)
 * only when the attempt as a whole produced no response.
 */
async function requestWithFallback(url: string, opts: ResolvedOptions): Promise<Response> {
  try {
    const head = await request(url, 'HEAD', opts);
    if (!HEAD_FALLBACK_STATUSES.has(head.status)) return head;
  } catch {
    // fall through to GET
  }
  const response = await request(url, 'GET', opts);
  await discardBody(response);
  return response;
}

function request(url: string, method: 'HEAD' | 'GET', opts: ResolvedOptions): Promise<Response> {
  return opts.fetchImpl(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs),
    headers: { 'user-agent': opts.userAgent, accept: '*/*' },
  });
}

/** Final URL when the (followed) response landed somewhere else. */
function redirectTarget(requestUrl: string, response: Response): string | undefined {
  const finalUrl = response.url;
  if (!finalUrl) return undefined;
  try {
    // Per WHATWG fetch, response.url never carries the #fragment — compare
    // without it, or every anchored link looks like a permanent redirect.
    const requested = new URL(requestUrl);
    requested.hash = '';
    if (requested.href === finalUrl) return undefined;
  } catch {
    return undefined;
  }
  return finalUrl;
}

function buildOutcome(
  url: string,
  ok: boolean,
  started: number,
  extras: { statusCode?: number; redirectedTo?: string; error?: string },
): LinkCheckOutcome {
  const outcome: LinkCheckOutcome = {
    url,
    ok,
    durationMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
  if (extras.statusCode !== undefined) outcome.statusCode = extras.statusCode;
  if (extras.redirectedTo !== undefined) outcome.redirectedTo = extras.redirectedTo;
  if (extras.error !== undefined) outcome.error = extras.error;
  return outcome;
}

function describeError(err: unknown, timeoutMs: number): string {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? (err as { name?: unknown }).name
      : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `timed out after ${timeoutMs}ms`;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Release the socket without downloading the body (GET fallback only). */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // best effort
  }
}
