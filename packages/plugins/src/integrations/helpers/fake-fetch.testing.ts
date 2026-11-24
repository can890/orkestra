/**
 * Yalnızca testler için: gerçek ağa çıkmadan kaydedilmiş biçimde yanıtlar döndüren sahte fetch.
 * Her çağrı kaydedilir (yöntem, URL, başlıklar, gövde); eşleşmeyen istek testi düşürür.
 */

export type FakeRoute = {
  method?: string;
  /** Tam URL, yol öneki ya da URL'yi sınayan işlev. */
  match: string | ((url: URL) => boolean);
  status?: number;
  body?: unknown;
  /** Ham metin gövde (ör. HTML giriş sayfası). */
  text?: string;
  headers?: Record<string, string>;
  /** Aynı rota için art arda farklı yanıtlar. */
  once?: boolean;
};

export type RecordedCall = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
};

export function createFakeFetch(routes: FakeRoute[]) {
  const calls: RecordedCall[] = [];
  const remaining = [...routes];

  async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string> | undefined) ?? {}).map(
        ([key, value]) => [key.toLowerCase(), value]
      )
    );
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers, body });

    const index = remaining.findIndex((route) => {
      if (route.method && route.method.toUpperCase() !== method) return false;
      if (typeof route.match === 'function') return route.match(url);
      return url.toString() === route.match || url.pathname.startsWith(route.match);
    });
    if (index < 0) throw new Error(`Unexpected request: ${method} ${url.toString()}`);
    const route = remaining[index];
    if (route.once) remaining.splice(index, 1);

    const text = route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body));
    return new Response(route.status === 204 ? null : text, {
      status: route.status ?? 200,
      headers: {
        ...(route.text === undefined ? { 'content-type': 'application/json' } : {}),
        ...route.headers,
      },
    });
  }

  return { fetch: fakeFetch, calls };
}
