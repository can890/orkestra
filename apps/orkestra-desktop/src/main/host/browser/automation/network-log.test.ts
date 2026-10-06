import { describe, expect, it } from 'vitest';
import { isTextMimeType, NetworkLog, REDACTED_HEADER_VALUE, redactHeaders } from './network-log';

function request(id: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    requestId: id,
    request: { url, method: 'GET', headers: { Accept: '*/*' } },
    type: 'Fetch',
    wallTime: 1_700_000_000,
    timestamp: 10,
    ...extra,
  };
}

describe('NetworkLog', () => {
  it('records a request through response and completion', () => {
    const log = new NetworkLog();
    log.handleEvent('Network.requestWillBeSent', request('1', 'https://api.test/items'));
    log.handleEvent('Network.responseReceived', {
      requestId: '1',
      type: 'XHR',
      timestamp: 10.1,
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=secret' },
      },
    });
    log.handleEvent('Network.loadingFinished', {
      requestId: '1',
      timestamp: 10.25,
      encodedDataLength: 512,
    });

    expect(log.read()).toEqual([
      {
        requestId: '1',
        url: 'https://api.test/items',
        method: 'GET',
        resourceType: 'XHR',
        state: 'finished',
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        startTime: 1_700_000_000_000,
        durationMs: 250,
        encodedSize: 512,
      },
    ]);
    expect(log.get('1')?.responseHeaders).toEqual({
      'Content-Type': 'application/json',
      'Set-Cookie': REDACTED_HEADER_VALUE,
    });
  });

  it('marks failures and cancellations, and filters failed requests', () => {
    const log = new NetworkLog();
    log.handleEvent('Network.requestWillBeSent', request('1', 'http://localhost:9/down'));
    log.handleEvent('Network.loadingFailed', {
      requestId: '1',
      errorText: 'net::ERR_CONNECTION_REFUSED',
      timestamp: 10.5,
    });
    log.handleEvent('Network.requestWillBeSent', request('2', 'https://api.test/cancel'));
    log.handleEvent('Network.loadingFailed', { requestId: '2', canceled: true });
    log.handleEvent('Network.requestWillBeSent', request('3', 'https://api.test/missing'));
    log.handleEvent('Network.responseReceived', { requestId: '3', response: { status: 404 } });
    log.handleEvent('Network.requestWillBeSent', request('4', 'https://api.test/ok'));
    log.handleEvent('Network.responseReceived', { requestId: '4', response: { status: 200 } });

    expect(log.read({ failedOnly: true }).map((entry) => [entry.requestId, entry.failure])).toEqual(
      [
        ['1', 'net::ERR_CONNECTION_REFUSED'],
        ['2', 'canceled'],
        ['3', undefined],
      ]
    );
  });

  it('keeps redirect hops as separate entries and the final request under the original id', () => {
    const log = new NetworkLog();
    log.handleEvent('Network.requestWillBeSent', request('1', 'http://site.test/'));
    log.handleEvent(
      'Network.requestWillBeSent',
      request('1', 'https://site.test/', {
        timestamp: 10.1,
        redirectResponse: { status: 301, headers: { Location: 'https://site.test/' } },
      })
    );

    const entries = log.read();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      requestId: '1:redirect-1',
      status: 301,
      state: 'finished',
      durationMs: 100,
    });
    expect(entries[1]).toMatchObject({
      requestId: '1',
      url: 'https://site.test/',
      state: 'pending',
    });
    expect(log.get('1')?.url).toBe('https://site.test/');
  });

  it('filters by URL, limits to the newest, clears, skips data URLs and drops the oldest', () => {
    const log = new NetworkLog(3);
    log.handleEvent('Network.requestWillBeSent', request('d', 'data:image/png;base64,AAAA'));
    for (const id of ['1', '2', '3', '4']) {
      log.handleEvent('Network.requestWillBeSent', request(id, `https://cdn.test/${id}.js`));
    }
    expect(log.read().map((entry) => entry.requestId)).toEqual(['2', '3', '4']);
    expect(log.get('1')).toBeNull();
    expect(log.read({ filter: 'CDN.TEST/3' }).map((entry) => entry.requestId)).toEqual(['3']);
    expect(log.read({ limit: 1 }).map((entry) => entry.requestId)).toEqual(['4']);
    expect(log.read({ clear: true })).toHaveLength(3);
    expect(log.read()).toEqual([]);
  });

  it('redacts credentials in request headers, including extra info headers', () => {
    const log = new NetworkLog();
    log.handleEvent(
      'Network.requestWillBeSent',
      request('1', 'https://api.test/', {
        request: {
          url: 'https://api.test/',
          method: 'POST',
          headers: { Authorization: 'Bearer abc', 'X-Trace': '1' },
        },
      })
    );
    log.handleEvent('Network.requestWillBeSentExtraInfo', {
      requestId: '1',
      headers: { cookie: 'sid=secret', 'proxy-authorization': 'Basic x' },
    });
    expect(log.get('1')?.requestHeaders).toEqual({
      Authorization: REDACTED_HEADER_VALUE,
      'X-Trace': '1',
      cookie: REDACTED_HEADER_VALUE,
      'proxy-authorization': REDACTED_HEADER_VALUE,
    });
  });
});

describe('network helpers', () => {
  it('redacts case-insensitively and ignores non-objects', () => {
    expect(redactHeaders({ COOKIE: 'a', Accept: 'b' })).toEqual({
      COOKIE: REDACTED_HEADER_VALUE,
      Accept: 'b',
    });
    expect(redactHeaders(null)).toEqual({});
  });

  it('recognizes text MIME types', () => {
    expect(isTextMimeType('application/json; charset=utf-8')).toBe(true);
    expect(isTextMimeType('text/html')).toBe(true);
    expect(isTextMimeType('application/vnd.api+json')).toBe(true);
    expect(isTextMimeType('image/svg+xml')).toBe(true);
    expect(isTextMimeType('image/png')).toBe(false);
    expect(isTextMimeType('application/octet-stream')).toBe(false);
    expect(isTextMimeType(undefined)).toBe(false);
  });
});
