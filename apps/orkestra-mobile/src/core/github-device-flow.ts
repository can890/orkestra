/**
 * GitHub OAuth "device flow" (RFC 8628): saf mantık; HTTP ve zamanlayıcılar dışarıdan verilir.
 * Erişim belirteci yalnızca `pollForToken` sonucunda döner; hiçbir hata, günlük ya da ileti
 * belirteci (ya da cihaz kodunu) içermez. İstenen izin yalnızca `gist`tir.
 */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_SCOPE = 'gist';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
/** Üst üste bu kadar ağ hatasında yoklama bırakılır. */
const MAX_CONSECUTIVE_NETWORK_ERRORS = 4;

/** `github.com` uç noktaları tarayıcı CORS'una izin vermez; cihazda yerel HTTP ile çağrılır. */
export type DeviceFlowHttp = (request: {
  url: string;
  body: Record<string, string>;
}) => Promise<{ status: number; body: unknown }>;

export type DeviceCode = {
  /** Gizli; yalnızca yoklamada kullanılır, arayüze verilmez. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
};

export type DeviceCodeResult =
  | { ok: true; code: DeviceCode }
  | { ok: false; reason: 'network' | 'invalid-response' | 'not-allowed' | 'cancelled' };

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'expired' | 'denied' | 'cancelled' | 'network' | 'failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CapacitorHttp bazen JSON'u metin olarak döndürür. */
function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(body) ? body : null;
}

export async function requestDeviceCode(input: {
  clientId: string;
  http: DeviceFlowHttp;
  signal?: AbortSignal;
}): Promise<DeviceCodeResult> {
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };
  let response: Awaited<ReturnType<DeviceFlowHttp>>;
  try {
    response = await input.http({
      url: GITHUB_DEVICE_CODE_URL,
      body: { client_id: input.clientId, scope: GITHUB_SCOPE },
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };
  const body = asRecord(response.body);
  if (!body) return { ok: false, reason: 'invalid-response' };
  // Yanlış istemci kimliği ya da uygulamada cihaz akışı kapalı.
  if (typeof body['error'] === 'string') return { ok: false, reason: 'not-allowed' };
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  if (
    response.status !== 200 ||
    typeof device_code !== 'string' ||
    typeof user_code !== 'string' ||
    typeof verification_uri !== 'string' ||
    typeof expires_in !== 'number' ||
    !(expires_in > 0)
  ) {
    return { ok: false, reason: 'invalid-response' };
  }
  return {
    ok: true,
    code: {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresInSec: expires_in,
      intervalSec: typeof interval === 'number' && interval >= 1 ? interval : DEFAULT_INTERVAL_S,
    },
  };
}

export type PollOptions = {
  clientId: string;
  code: DeviceCode;
  http: DeviceFlowHttp;
  /** İptalde erken döner. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
};

/**
 * Kullanıcı GitHub'da kodu onaylayana kadar `interval` saniyede bir sorar. İptal edilirse, uçuştaki
 * bir yanıt belirteç taşısa bile atılır (`cancelled`).
 */
export async function pollForToken(options: PollOptions): Promise<TokenResult> {
  const { code, signal } = options;
  const deadline = options.now() + code.expiresInSec * 1000;
  let intervalSec = code.intervalSec;
  let networkErrors = 0;
  for (;;) {
    await options.sleep(intervalSec * 1000, signal);
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    if (options.now() >= deadline) return { ok: false, reason: 'expired' };
    let response: Awaited<ReturnType<DeviceFlowHttp>>;
    try {
      response = await options.http({
        url: GITHUB_ACCESS_TOKEN_URL,
        body: {
          client_id: options.clientId,
          device_code: code.deviceCode,
          grant_type: DEVICE_GRANT,
        },
      });
    } catch {
      networkErrors += 1;
      if (networkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) return { ok: false, reason: 'network' };
      continue;
    }
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    networkErrors = 0;
    const body = asRecord(response.body);
    if (!body) {
      if (response.status >= 500) continue;
      return { ok: false, reason: 'failed' };
    }
    const accessToken = body['access_token'];
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      return { ok: true, token: accessToken };
    }
    switch (body['error']) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        intervalSec += SLOW_DOWN_STEP_S;
        break;
      case 'expired_token':
        return { ok: false, reason: 'expired' };
      case 'access_denied':
        return { ok: false, reason: 'denied' };
      default:
        return { ok: false, reason: 'failed' };
    }
  }
}

/** Kullanıcıya gösterilecek Türkçe açıklamalar (belirteç ya da kod içermez). */
export function describeDeviceCodeFailure(
  reason: Exclude<DeviceCodeResult, { ok: true }>['reason']
) {
  switch (reason) {
    case 'network':
      return "GitHub'a ulaşılamadı; internet bağlantısını kontrol edin.";
    case 'not-allowed':
      return 'GitHub bu uygulamaya cihaz girişi izni vermiyor. Daha sonra tekrar deneyin ya da QR ile eşleştirin.';
    case 'invalid-response':
      return 'GitHub beklenmeyen bir yanıt verdi; tekrar deneyin.';
    case 'cancelled':
      return 'Giriş iptal edildi.';
  }
}

export function describeTokenFailure(reason: Exclude<TokenResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'GitHub kodunun süresi doldu. Yeniden deneyin.';
    case 'denied':
      return "GitHub'da giriş reddedildi.";
    case 'network':
      return "GitHub'a ulaşılamadı; internet bağlantısını kontrol edin.";
    case 'cancelled':
      return 'Giriş iptal edildi.';
    case 'failed':
      return 'GitHub girişi tamamlanamadı; tekrar deneyin.';
  }
}
