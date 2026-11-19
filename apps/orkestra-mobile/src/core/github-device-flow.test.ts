import { describe, expect, it } from 'vitest';
import {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  pollForToken,
  requestDeviceCode,
  type DeviceCode,
  type DeviceFlowHttp,
} from './github-device-flow';

const TOKEN = 'gho_SECRETTOKEN123';
const DEVICE_CODE = 'device-code-secret-xyz';
const CLIENT_ID = 'test-client-id';

const code: DeviceCode = {
  deviceCode: DEVICE_CODE,
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresInSec: 900,
  intervalSec: 5,
};

/** Sahte saat: `sleep` saati ilerletir, gerçek bekleme yok. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      sleeps.push(ms);
      time += ms;
    },
  };
}

function scripted(responses: unknown[]): {
  http: DeviceFlowHttp;
  calls: { url: string; body: Record<string, string> }[];
} {
  const calls: { url: string; body: Record<string, string> }[] = [];
  let index = 0;
  const http: DeviceFlowHttp = async (request) => {
    calls.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return { status: 200, body: next };
  };
  return { http, calls };
}

describe('requestDeviceCode', () => {
  it('yalnızca gist iznini ister ve yanıtı çözer', async () => {
    const { http, calls } = scripted([
      {
        device_code: DEVICE_CODE,
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    ]);
    const result = await requestDeviceCode({ clientId: CLIENT_ID, http });
    expect(result).toEqual({ ok: true, code });
    expect(calls).toEqual([
      { url: GITHUB_DEVICE_CODE_URL, body: { client_id: CLIENT_ID, scope: 'gist' } },
    ]);
  });

  it('JSON metni olarak gelen yanıtı da çözer', async () => {
    const { http } = scripted([
      JSON.stringify({
        device_code: DEVICE_CODE,
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
      }),
    ]);
    const result = await requestDeviceCode({ clientId: CLIENT_ID, http });
    expect(result.ok && result.code.intervalSec).toBe(5);
  });

  it('GitHub hata döndürürse, ağ düşerse ya da yanıt bozuksa neden bildirir', async () => {
    expect(
      await requestDeviceCode({
        clientId: CLIENT_ID,
        http: scripted([{ error: 'device_flow_disabled' }]).http,
      })
    ).toEqual({ ok: false, reason: 'not-allowed' });
    expect(
      await requestDeviceCode({ clientId: CLIENT_ID, http: scripted([new Error('boom')]).http })
    ).toEqual({ ok: false, reason: 'network' });
    expect(
      await requestDeviceCode({ clientId: CLIENT_ID, http: scripted([{ hello: 1 }]).http })
    ).toEqual({ ok: false, reason: 'invalid-response' });
  });
});

describe('pollForToken', () => {
  it('beklemede kalır, sonra belirteci verir; her sorguda interval kadar bekler', async () => {
    const clock = fakeClock();
    const { http, calls } = scripted([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: TOKEN, token_type: 'bearer', scope: 'gist' },
    ]);
    const result = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: true, token: TOKEN });
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
    expect(calls[0]).toEqual({
      url: GITHUB_ACCESS_TOKEN_URL,
      body: {
        client_id: CLIENT_ID,
        device_code: DEVICE_CODE,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
    });
  });

  it('slow_down aralığı 5 sn artırır', async () => {
    const clock = fakeClock();
    const { http } = scripted([
      { error: 'slow_down' },
      { error: 'authorization_pending' },
      { access_token: TOKEN },
    ]);
    const result = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(clock.sleeps).toEqual([5000, 10_000, 10_000]);
  });

  it('süre dolunca expired döner (expired_token ya da yerel süre)', async () => {
    const clock = fakeClock();
    const remote = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http: scripted([{ error: 'expired_token' }]).http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(remote).toEqual({ ok: false, reason: 'expired' });

    const local = await pollForToken({
      clientId: CLIENT_ID,
      code: { ...code, expiresInSec: 12 },
      http: scripted([{ error: 'authorization_pending' }]).http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(local).toEqual({ ok: false, reason: 'expired' });
  });

  it('access_denied reddedildi olarak döner; bilinmeyen hata failed', async () => {
    const clock = fakeClock();
    const base = { clientId: CLIENT_ID, code, sleep: clock.sleep, now: clock.now };
    expect(
      await pollForToken({
        ...base,
        http: scripted([{ error: 'access_denied' }]).http,
        signal: new AbortController().signal,
      })
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      await pollForToken({
        ...base,
        http: scripted([{ error: 'incorrect_device_code' }]).http,
        signal: new AbortController().signal,
      })
    ).toEqual({ ok: false, reason: 'failed' });
  });

  it('geçici ağ hatalarını atlar, sürekli hatada network döner', async () => {
    const clock = fakeClock();
    const flaky = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http: scripted([new Error('x'), { access_token: TOKEN }]).http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(flaky.ok).toBe(true);
    const dead = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http: scripted([new Error('x')]).http,
      sleep: clock.sleep,
      now: clock.now,
      signal: new AbortController().signal,
    });
    expect(dead).toEqual({ ok: false, reason: 'network' });
  });

  it('iptal edilince durur; uçuştaki yanıt belirteç taşısa bile atılır', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const http: DeviceFlowHttp = async () => {
      controller.abort();
      return { status: 200, body: { access_token: TOKEN } };
    };
    const result = await pollForToken({
      clientId: CLIENT_ID,
      code,
      http,
      sleep: clock.sleep,
      now: clock.now,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    const early = new AbortController();
    early.abort();
    expect(
      await pollForToken({
        clientId: CLIENT_ID,
        code,
        http: scripted([{ access_token: TOKEN }]).http,
        sleep: clock.sleep,
        now: clock.now,
        signal: early.signal,
      })
    ).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('hiçbir hata sonucu belirteci ya da cihaz kodunu içermez', async () => {
    const clock = fakeClock();
    const results = await Promise.all(
      ['expired_token', 'access_denied', 'weird'].map((error) =>
        pollForToken({
          clientId: CLIENT_ID,
          code,
          http: scripted([{ error, access_token_hint: TOKEN }]).http,
          sleep: clock.sleep,
          now: clock.now,
          signal: new AbortController().signal,
        })
      )
    );
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(DEVICE_CODE);
    }
  });
});
