import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
process.env.ORKESTRA_ELEVENLABS_TEST = '1';
const root = await mkdtemp(join(tmpdir(), 'orkestra-elevenlabs-'));
process.env.ORKESTRA_ELEVENLABS_DIRECTORY = root;
const { withConnectionLock, forwardAudioTool } = await import('./mcp-bridge.mjs');
test('concurrent callers do not refresh the shared account simultaneously', async () => {
  let active = 0,
    peak = 0;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withConnectionLock(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
      })
    )
  );
  assert.equal(peak, 1);
});
test('failed requests release the account lock', async () => {
  await assert.rejects(
    withConnectionLock(async () => {
      throw new Error('test');
    })
  );
  assert.equal(await withConnectionLock(async () => 42), 42);
  await assert.rejects(access(join(root, 'connection.lock')));
});
test('a crashed bridge does not permanently block the next request', async () => {
  const lock = join(root, 'connection.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), '2147483647');
  assert.equal(await withConnectionLock(async () => 42), 42);
});
test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('video and image generation cannot be called directly or through generic flow tools', async () => {
  let calls = 0;
  const client = {
    callTool: async () => {
      calls++;
    },
  };
  for (const name of [
    'creative_generate_video',
    'creative_generate_image',
    'creative_generate_in_flow',
    'creative_add_flow_node',
    'creative_run_flow_nodes',
    'creative_update_node',
  ]) {
    await assert.rejects(forwardAudioTool(client, { name, arguments: {} }, {}), /yalnızca ses/);
  }
  assert.equal(calls, 0);
});
test('speech generation preserves the actual request and result', async () => {
  const params = { name: 'creative_generate_speech', arguments: { prompt: 'Merhaba' } };
  const result = { content: [{ type: 'text', text: 'ses sonucu' }] };
  const client = {
    callTool: async (received) => {
      assert.equal(received, params);
      return result;
    },
  };
  assert.equal(await forwardAudioTool(client, params, {}), result);
});

// SDK'nin gerçek auth akışı, redirectUrl olmayan köprüde refresh grant'ini kullanmalı.
test('headless SDK authentication refreshes credentials and preserves refresh tokens', async () => {
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
  const { createAuthProvider } = await import('./mcp-bridge.mjs');
  let stored = {
    client_id: 'test-client',
    token_response: {
      access_token: 'expired',
      refresh_token: 'refresh-original',
      token_type: 'Bearer',
    },
  };
  const provider = createAuthProvider(async (action, tokens) => {
    if (action === 'save') stored = { ...stored, token_response: tokens };
    return structuredClone(stored);
  });
  provider.discoveryState = async () => ({
    authorizationServerUrl: 'https://auth.example',
    authorizationServerMetadata: {
      issuer: 'https://auth.example',
      token_endpoint: 'https://auth.example/token',
      token_endpoint_auth_methods_supported: ['none'],
    },
    resourceMetadata: { resource: 'https://audio.example/mcp' },
  });
  for (const rotated of [undefined, 'refresh-rotated']) {
    let requests = 0;
    const result = await auth(provider, {
      serverUrl: new URL('https://audio.example/mcp'),
      fetchFn: async (url, init) => {
        requests++;
        assert.equal(String(url), 'https://auth.example/token');
        assert.equal(init.method, 'POST');
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'refresh-original');
        assert.equal(body.get('client_id'), 'test-client');
        assert.equal(body.get('resource'), 'https://audio.example/mcp');
        return Response.json({
          access_token: 'renewed',
          token_type: 'Bearer',
          expires_in: 3600,
          ...(rotated ? { refresh_token: rotated } : {}),
        });
      },
    });
    assert.equal(result, 'AUTHORIZED');
    assert.equal(requests, 1);
    assert.equal(stored.token_response.access_token, 'renewed');
    assert.equal(stored.token_response.refresh_token, rotated || 'refresh-original');
  }
  assert.equal((await provider.prepareTokenRequest()).get('refresh_token'), 'refresh-rotated');
});

test('missing refresh grant asks for reconnection without exposing credentials', async () => {
  const { createAuthProvider } = await import('./mcp-bridge.mjs');
  const provider = createAuthProvider(async () => ({
    token_response: { access_token: 'private-token' },
  }));
  await assert.rejects(provider.prepareTokenRequest(), /Hesabı yeniden bağlayın/);
});
