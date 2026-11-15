/**
 * `BackendClient.checkScript` — the transport seam of the editor's authoritative layer.
 *
 * This is the one place that knows the endpoint's own envelope
 * (`{ok:true,lint:{impure:[]}}` / `{ok:false,error:{code,...}}`), which is NOT the global
 * `{code:...}` error body. The card tests mock this module, so without these cases the
 * mapping would be untested: a server that returns `{ok:false,...}` with HTTP 200 must not
 * throw, a transport failure must not look like a clean script, and a backend too old to
 * have the endpoint must be distinguishable from "your script compiles".
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BackendClient, type ScriptCheckResult } from '../src/backend/client.ts';

interface Call {
  url: string;
  method: string;
  body?: string;
}

const BASE = 'http://backend.test/api';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub fetch with one canned answer; records the call it received. */
async function check(
  reply: { status?: number; body: unknown },
  script = 'result = 1\n',
): Promise<{ result: ScriptCheckResult; call: Call }> {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const status = reply.status ?? 200;
    const text = JSON.stringify(reply.body);
    return {
      ok: status < 400,
      status,
      text: async () => text,
      json: async () => reply.body,
    } as unknown as Response;
  }) as typeof fetch;
  const result = await new BackendClient(BASE).checkScript(script);
  expect(calls).toHaveLength(1);
  return { result, call: calls[0] };
}

describe('checkScript: the check envelope', () => {
  it('posts the script and forwards the impurity labels', async () => {
    const { result, call } = await check({
      body: { ok: true, lint: { impure: ['import socket', 'open()'] } },
    });
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE}/script/check`);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ script: 'result = 1\n' });
    expect(result).toEqual({ ok: true, impure: ['import socket', 'open()'] });
  });

  it('reports a clean script as an empty list, not as a failure', async () => {
    const { result } = await check({ body: { ok: true, lint: { impure: [] } } });
    expect(result.ok).toBe(true);
    expect(result.impure).toEqual([]);
  });

  it('carries the backend line and column through a syntax error', async () => {
    const { result } = await check({
      body: {
        ok: false,
        error: { code: 'syntaxError', line: 2, col: 5, message: "'(' was never closed" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: 'syntaxError',
      line: 2,
      col: 5,
      message: "'(' was never closed",
    });
    // A verdict is not an error body: nothing to lint when the script does not compile.
    expect(result.impure).toEqual([]);
  });

  it('keeps runtimeMissing distinct from a syntax verdict', async () => {
    const { result } = await check({ body: { ok: false, error: { code: 'runtimeMissing' } } });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'runtimeMissing' });
  });

  it('treats a dropped connection as "the check could not run", never as success', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    const result = await new BackendClient(BASE).checkScript('result = 1\n');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('backendUnavailable');
  });

  it('treats a backend without the endpoint (404) as unavailable', async () => {
    // An older deployment answers 404 with the global `{code:...}` body.
    const { result } = await check({ status: 404, body: { code: 'notFound' } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('backendUnavailable');
  });

  it('refuses to call an "ok" without a lint list reproducible', async () => {
    const { result } = await check({ body: { ok: true } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('internalError');
  });
});