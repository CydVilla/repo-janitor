import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSleepForTests, checkLinks } from '../src/link-checker/check.js';

function res(status: number, finalUrl?: string): Response {
  const response = new Response(null, { status });
  if (finalUrl !== undefined) {
    Object.defineProperty(response, 'url', { value: finalUrl });
  }
  return response;
}

beforeEach(() => {
  __setSleepForTests(async () => {});
});

afterEach(() => {
  __setSleepForTests();
});

describe('redirect detection for URLs with #fragments', () => {
  it('does not report a redirect when only the fragment differs (response.url never carries it)', async () => {
    const fetchImpl = (async () => res(200, 'https://host.test/page')) as unknown as typeof fetch;

    const [outcome] = await checkLinks(['https://host.test/page#install'], { fetchImpl });

    expect(outcome!.ok).toBe(true);
    expect(outcome!.redirectedTo).toBeUndefined();
  });

  it('still reports a real redirect for an anchored URL', async () => {
    const fetchImpl = (async () => res(200, 'https://host.test/moved')) as unknown as typeof fetch;

    const [outcome] = await checkLinks(['https://host.test/page#install'], { fetchImpl });

    expect(outcome!.redirectedTo).toBe('https://host.test/moved');
  });
});
