export const mcpOAuthBridgeSource = String.raw`
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const credentialPath = process.argv[2];
const audioTools = new Set(['creative_generate_speech', 'creative_list_voices', 'creative_get_flow_run_status', 'creative_show_flow_results', 'creative_get_flow', 'creative_get_flow_node', 'creative_get_model_schema', 'creative_get_model_guide']);
let sessionId;
let protocolVersion;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function readGrant() { return JSON.parse(await readFile(credentialPath, 'utf8')); }
async function saveGrant(grant) {
  const temporary = credentialPath + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(grant), { mode: 0o600 });
  await rename(temporary, credentialPath);
}
async function withRefreshLock(work) {
  const path = join(dirname(credentialPath), 'refresh.lock');
  const started = Date.now();
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lockTime;
      try { lockTime = (await stat(path)).mtimeMs; } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      if (Date.now() - lockTime > 120000) { await rm(path, { recursive: true, force: true }); continue; }
      if (Date.now() - started > 45000) throw new Error('Hesap oturumu yenileniyor. Biraz sonra yeniden deneyin.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { await rm(path, { recursive: true, force: true }); }
}
async function accessToken(force = false) {
  return withRefreshLock(async () => {
    const grant = await readGrant();
    if (!force && (!grant.expires_at || grant.expires_at > Date.now() + 60000)) return grant.access_token;
    if (!grant.refresh_token) throw new Error('Hesap oturumunun süresi doldu. Entegrasyonu yeniden bağlayın.');
    const issuer = new URL(grant.issuer || grant.server_url);
    if (issuer.protocol !== 'https:') throw new Error('Güvenli olmayan hesap sunucusu.');
    const metadataUrl = new URL('/.well-known/oauth-authorization-server' + (issuer.pathname === '/' ? '' : issuer.pathname), issuer);
    let response = await fetch(metadataUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok && issuer.pathname !== '/') response = await fetch(new URL('/.well-known/oauth-authorization-server', issuer), { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Hesap yenileme bilgileri alınamadı.');
    const metadata = await response.json();
    if (grant.issuer && metadata.issuer && new URL(metadata.issuer).href !== issuer.href) throw new Error('Hesap sunucusu doğrulanamadı.');
    if (!grant.issuer && metadata.issuer) {
      const discoveredIssuer = new URL(metadata.issuer);
      if (discoveredIssuer.protocol !== 'https:') throw new Error('Hesap sunucusu doğrulanamadı.');
      grant.issuer = discoveredIssuer.href;
    }
    const tokenUrl = new URL(metadata.token_endpoint);
    if (tokenUrl.protocol !== 'https:') throw new Error('Güvenli olmayan oturum yenileme adresi.');
    response = await fetch(tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: grant.client_id, resource: grant.server_url }) });
    if (!response.ok) throw new Error('Hesap oturumu yenilenemedi. Entegrasyonu yeniden bağlayın.');
    const tokens = await response.json();
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Hesap geçerli oturum vermedi.');
    await saveGrant({ ...grant, access_token: tokens.access_token, refresh_token: tokens.refresh_token || grant.refresh_token, expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null });
    return tokens.access_token;
  });
}
function filterMessage(message, grant) {
  if (grant.audio_only && message.result?.tools) message.result.tools = message.result.tools.filter(tool => audioTools.has(tool.name));
  if (message.result?.protocolVersion) protocolVersion = message.result.protocolVersion;
  return message;
}
async function relay(message) {
  const grant = await readGrant();
  if (grant.audio_only && message.method === 'tools/call' && !audioTools.has(message.params?.name)) throw new Error('ElevenLabs yalnızca ses üretir. Videoyu kodlama araçlarıyla hazırlayın.');
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer ' + await accessToken() };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  const request = { method: 'POST', redirect: 'error', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(180000) };
  let response = await fetch(grant.server_url, request);
  if (response.status === 401) { headers.Authorization = 'Bearer ' + await accessToken(true); response = await fetch(grant.server_url, { ...request, signal: AbortSignal.timeout(180000) }); }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Hesap bu işleme izin vermiyor. Bağlantıyı yeniden kontrol edin.' : 'Servis isteği tamamlanamadı. Yeniden deneyin.');
  sessionId = response.headers.get('Mcp-Session-Id') || sessionId;
  if (response.status === 202 || response.status === 204) return;
  if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) send(filterMessage(JSON.parse(data), grant));
      }
    }
  } else {
    const text = await response.text();
    if (text.trim()) send(filterMessage(JSON.parse(text), grant));
  }
}
let initialized = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const operation = async () => {
    try { await relay(message); }
    catch (error) { if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message?.startsWith('ElevenLabs') || error.message?.startsWith('Hesap') || error.message?.startsWith('Servis') ? error.message : 'Servise bağlanılamadı. Hesap bağlantısını kontrol edin.' } }); }
  };
  if (message.method === 'initialize' || message.method === 'notifications/initialized') initialized = initialized.then(operation);
  else void initialized.then(operation);
});
`;
