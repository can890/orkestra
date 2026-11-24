#!/usr/bin/env node
/**
 * Sovra SSH Bakım, Model Senkronizasyonu ve Headless OAuth Giriş Aracı
 *
 * Huawei (veya herhangi bir SSH) sunucusuna fiziksel ekran/tarayıcı erişimi olmadan:
 *   1) durum    [host]           — workspace-server sürümü, CLI sürümleri, oturumlar ve canlı ACP modelleri
 *   2) guncelle [host]           — CLI'ları günceller, workspace-server'ı derleyip kurar ve doğrular
 *   3) giris    <arac> [host]    — claude | agy | codex | kimi | grok için Mac tarayıcılı + otomatik SSH tünelli OAuth girişi
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = realpathSync(fileURLToPath(import.meta.url));
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const DEFAULT_HOST = process.env.SOVRA_SSH_HOST || 'huawei';
const REMOTE_PATH_EXPORT =
  'export PATH="$HOME/.local/bin:$HOME/.kimi-code/bin:$HOME/.grok/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"';

function usage() {
  console.log(`
Sovra SSH Bakım ve Model Senkronizasyon Aracı

Kullanım:
  sovra-ssh-bakim durum [host]
      Uzak sunucudaki workspace-server sürümünü, CLI sürümlerini, oturumları
      ve canlı ACP model sayılarını denetler (varsayılan host: ${DEFAULT_HOST}).

  sovra-ssh-bakim guncelle [host]
      1. Uzak sunucudaki Claude, Codex, Kimi, Grok CLI sürümlerini günceller.
      2. Repodan @orkestra/core, @orkestra/plugins ve @orkestra/workspace-server derler.
      3. Güncel workspace-server'ı uzak sunucuya atomik olarak kurar ve daemon'ı yeniler.
      4. Canlı ACP üzerinden tüm sağlayıcıların model listelerini doğrular.

  sovra-ssh-bakim giris <claude|agy|codex|kimi|grok> [host]
      Uzak sunucuya fiziksel erişim olmadan resmi OAuth girişi yapar:
      - OAuth URL'sini otomatik yakalayıp Mac tarayıcısında açar.
      - URL içinde localhost:<PORT> callback varsa Mac -> SSH tünelini otomatik kurar.
      - Kod yapıştırma gerekiyorsa doğrudan bu terminalden alır.
      - Giriş bitince oturum ve canlı model listesini doğrular.
`);
}

function runSshCapture(host, remoteScript, { timeout = 30000 } = {}) {
  return execFileSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, `${REMOTE_PATH_EXPORT}\n${remoteScript}`],
    { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function runLocal(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function openUrlOnMac(url) {
  try {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function extractCallbackPort(url) {
  try {
    const parsed = new URL(url);
    const redirect =
      parsed.searchParams.get('redirect_uri') ||
      parsed.searchParams.get('redirect') ||
      parsed.searchParams.get('callback') ||
      '';
    if (redirect) {
      const rUrl = new URL(redirect);
      if (
        (rUrl.hostname === 'localhost' || rUrl.hostname === '127.0.0.1') &&
        rUrl.port
      ) {
        return Number(rUrl.port);
      }
    }
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      parsed.port
    ) {
      return Number(parsed.port);
    }
  } catch {
    const m = url.match(/(?:localhost|127\.0\.0\.1)(?::|%3A)(\d{4,5})/i);
    if (m) return Number(m[1]);
  }
  return null;
}

async function cmdStatus(host) {
  console.log(`\n=== Sovra SSH Durum Denetimi (${host}) ===\n`);

  const script = `
ROOT="$HOME/.orkestra/workspace-server"
echo "[workspace-server]"
"$ROOT/current/bin/orkestra-workspace-server" status --socket "$ROOT/run/workspace.sock" 2>&1 || echo "daemon durmuş"
echo "symlink: $(readlink "$ROOT/current" 2>/dev/null || echo yok)"
echo ""
echo "[CLI Sürümleri]"
echo "  agy:    $(agy --version 2>/dev/null || echo 'kurulu değil')"
echo "  codex:  $(codex --version 2>/dev/null || echo 'kurulu değil')"
echo "  claude: $(claude --version 2>/dev/null || echo 'kurulu değil')"
echo "  kimi:   $(kimi --version 2>/dev/null || echo 'kurulu değil')"
echo "  grok:   $(grok --version 2>/dev/null || echo 'kurulu değil')"
echo ""
echo "[Oturum Durumları]"
CLAUDE_JSON=$(claude auth status 2>/dev/null || true)
if echo "$CLAUDE_JSON" | grep -q '"loggedIn":[[:space:]]*true'; then
  CLAUDE_PLAN=$(echo "$CLAUDE_JSON" | grep -oE '"planTier":[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4 || true)
  echo "  claude: oturum açık (\${CLAUDE_PLAN:-aktif})"
else
  echo "  claude: oturum kapalı (giriş için: sovra-ssh-bakim giris claude)"
fi
CODEX_AUTH=$(codex login status 2>&1 | tr '\n' ' ' | cut -c1-80 || echo 'bilinmiyor')
echo "  codex:  $CODEX_AUTH"
AGY_MODELS_OUT=$(agy models 2>&1 || true)
if echo "$AGY_MODELS_OUT" | grep -q "gemini-4-neon"; then
  echo "  agy:    oturum açık (canlı liste aktif)"
else
  echo "  agy:    CLI girişi yok (27 modelli güncel katalog aktif; giriş için: sovra-ssh-bakim giris agy)"
fi
echo ""
echo "[Canlı ACP Model Sayıları]"
"$ROOT/current/node" -e '
const { spawn } = require("child_process");
const readline = require("readline");
function probe(label, cmd, args, extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
    const rl = readline.createInterface({ input: p.stdout });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; p.kill(); resolve({ label, error: "timeout" }); } }, 25000);
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }) + "\\n");
        else if (msg.id === 2) {
          done = true; clearTimeout(t); p.kill();
          const opt = (msg.result?.configOptions || []).find(o => o.id === "model" || o.category === "model");
          const models = (opt?.options || []).map(m => m.value);
          resolve({ label, count: models.length, sample: models.slice(0, 5) });
        }
      } catch {}
    });
    p.on("exit", (c) => { if (!done) { done = true; clearTimeout(t); resolve({ label, error: "exit " + c }); } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\\n");
  });
}
(async () => {
  const node = process.execPath;
  const dir = process.env.HOME + "/.orkestra/workspace-server/current/dist/adapters";
  const out = await Promise.all([
    probe("antigravity", node, [dir + "/antigravity-acp.mjs"], { ORKESTRA_AGY_EXECUTABLE: process.env.HOME + "/.local/bin/agy" }),
    probe("codex", node, [dir + "/codex-acp.cjs"], { CODEX_PATH: process.env.HOME + "/.local/bin/codex" }),
    probe("claude", node, [dir + "/claude-acp.mjs"], { CLAUDE_CODE_EXECUTABLE: process.env.HOME + "/.local/bin/claude" }),
  ]);
  for (const r of out) {
    if (r.error) console.log("  " + r.label + ": HATA (" + r.error + ")");
    else console.log("  " + r.label + ": " + r.count + " model (" + r.sample.join(", ") + "...)");
  }
})();
'
`;
  const output = runSshCapture(host, script, { timeout: 60000 });
  process.stdout.write(output);
}

async function cmdUpdate(host) {
  const wsPkgPath = resolve(REPO_ROOT, 'apps/workspace-server/package.json');
  if (!existsSync(wsPkgPath)) {
    throw new Error(`workspace-server package.json bulunamadı: ${wsPkgPath}`);
  }
  const wsVersion = JSON.parse(readFileSync(wsPkgPath, 'utf8')).version;

  console.log(`\n=== 1/4: Uzak CLI'lar Güncelleniyor (${host}) ===`);
  runLocal('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `${REMOTE_PATH_EXPORT}
echo "-> Claude güncelleniyor..."
claude update 2>&1 || true
echo "-> Codex güncelleniyor..."
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=true sh 2>&1 || true
echo "-> Grok güncelleniyor..."
grok update 2>&1 || true
`,
  ]);

  console.log(`\n=== 2/4: @orkestra/core, @orkestra/plugins, @orkestra/workspace-server (${wsVersion}) Derleniyor ===`);
  runLocal('pnpm', ['--filter', '@orkestra/core', 'build'], { cwd: REPO_ROOT });
  runLocal('pnpm', ['--filter', '@orkestra/plugins', 'build'], { cwd: REPO_ROOT });
  runLocal('pnpm', ['--filter', '@orkestra/workspace-server', 'build'], { cwd: REPO_ROOT });

  console.log(`\n=== 3/4: workspace-server ${wsVersion} Uzak Sunucuya Kuruluyor (${host}) ===`);
  const wsDist = resolve(REPO_ROOT, 'apps/workspace-server/dist');
  const adaptersDist = resolve(REPO_ROOT, 'packages/plugins/dist/adapters');

  runLocal('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `set -euo pipefail
ROOT="$HOME/.orkestra/workspace-server"
BASE=$(readlink -f "$ROOT/current")
STAGE="$ROOT/versions/${wsVersion}.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/dist/adapters"
cp -a "$BASE/node" "$STAGE/node"
cp -a "$BASE/bin/rg" "$STAGE/bin/rg"
cp -a "$BASE/licenses" "$STAGE/licenses"
cp -a "$BASE/node_modules" "$STAGE/node_modules"
`,
  ]);

  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  execFileSync(
    'sh',
    [
      '-c',
      `tar -C "$1" -cf - . | ssh -o BatchMode=yes "$2" 'tar -C "$HOME/.orkestra/workspace-server/versions/${wsVersion}.staging/dist" -xf -'`,
      '--',
      wsDist,
      host,
    ],
    { env: tarEnv, stdio: 'inherit' }
  );
  execFileSync(
    'sh',
    [
      '-c',
      `tar -C "$1" -cf - . | ssh -o BatchMode=yes "$2" 'tar -C "$HOME/.orkestra/workspace-server/versions/${wsVersion}.staging/dist/adapters" -xf -'`,
      '--',
      adaptersDist,
      host,
    ],
    { env: tarEnv, stdio: 'inherit' }
  );

  runLocal('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `set -euo pipefail
ROOT="$HOME/.orkestra/workspace-server"
STAGE="$ROOT/versions/${wsVersion}.staging"
find "$STAGE/dist" -name '._*' -delete
cat > "$STAGE/manifest.json" << 'EOF'
{
  "name": "@orkestra/workspace-server",
  "version": "${wsVersion}",
  "protocolVersion": "10.1.0",
  "os": "linux",
  "arch": "x64",
  "nodeVersion": "24.14.0",
  "ripgrepVersion": "15.2.0"
}
EOF
cat > "$STAGE/bin/orkestra-workspace-server" << 'EOF'
#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
export ORKESTRA_WS_APP_VERSION='${wsVersion}'
export ORKESTRA_WS_RIPGREP_PATH="$root_dir/bin/rg"
exec "$root_dir/node" "$root_dir/dist/index.mjs" "$@"
EOF
chmod +x "$STAGE/bin/orkestra-workspace-server"

# İzole smoke-test
TMP_DIR=$(mktemp -d)
"$STAGE/bin/orkestra-workspace-server" start --socket "$TMP_DIR/ws.sock"
"$STAGE/bin/orkestra-workspace-server" status --socket "$TMP_DIR/ws.sock"
"$STAGE/bin/orkestra-workspace-server" stop --socket "$TMP_DIR/ws.sock"
rm -rf "$TMP_DIR"

# Atomik geçiş ve daemon yenileme
"$ROOT/current/bin/orkestra-workspace-server" stop --socket "$ROOT/run/workspace.sock" || true
rm -rf "$ROOT/versions/${wsVersion}"
mv "$STAGE" "$ROOT/versions/${wsVersion}"
ln -sfn "versions/${wsVersion}" "$ROOT/current"
"$ROOT/current/bin/orkestra-workspace-server" start --socket "$ROOT/run/workspace.sock"
ln -sfn "versions/${wsVersion}" "$ROOT/current"
"$ROOT/current/bin/orkestra-workspace-server" status --socket "$ROOT/run/workspace.sock"
`,
  ]);

  console.log(`\n=== 4/4: Canlı Doğrulama (${host}) ===`);
  await cmdStatus(host);
}

async function cmdLogin(tool, host) {
  const commands = {
    claude: 'BROWSER=echo claude auth login',
    agy: 'BROWSER=echo agy',
    codex: 'BROWSER=echo codex login --device-auth',
    kimi: 'BROWSER=echo kimi login',
    grok: 'BROWSER=echo grok login',
  };
  const remoteCmd = commands[tool];
  if (!remoteCmd) {
    console.error(`Desteklenmeyen araç: ${tool}. Kullanılabilirler: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== ${tool.toUpperCase()} Uzak OAuth Girişi (${host}) ===`);
  console.log('• OAuth bağlantısı göründüğünde Mac tarayıcısında otomatik açılacak.');
  console.log('• Gerekirse localhost callback portu için SSH tüneli otomatik kurulacak.');
  console.log('• Tarayıcı kod verirse doğrudan bu terminale yapıştırıp Enter’a bas.\n');

  const openedUrls = new Set();
  const tunnels = [];
  let lineBuffer = '';

  const child = spawn(
    'ssh',
    ['-tt', '-o', 'ConnectTimeout=10', host, `stty cols 512 2>/dev/null || true; ${REMOTE_PATH_EXPORT}; ${remoteCmd}`],
    { stdio: ['inherit', 'pipe', 'pipe'] }
  );

  const handleCompletedLine = (line) => {
    const clean = stripAnsi(line).trim();
    if (!clean) return;
    const urls = clean.match(/https:\/\/[^\s"'<>)\]]+/g) || [];
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[.,;]+$/, '');
      if (openedUrls.has(url)) continue;
      if (
        !/oauth|authorize|login|device|accounts\.google\.com|auth\.openai\.com|claude\.ai|kimi\.com|x\.ai/i.test(
          url
        )
      ) {
        continue;
      }
      openedUrls.add(url);
      const port = extractCallbackPort(url);
      if (port) {
        const tunnel = spawn(
          'ssh',
          ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`, host],
          { stdio: 'ignore' }
        );
        tunnels.push(tunnel);
        console.error(`\n[sovra-ssh-bakim] SSH tüneli açıldı: localhost:${port} -> ${host}:${port}`);
      }
      setTimeout(() => {
        if (openUrlOnMac(url)) {
          console.error(
            `\n[sovra-ssh-bakim] Mac tarayıcısında açıldı. Onaylayıp çıkan kodu aşağıya yapıştır ve Enter'a bas.\n`
          );
        }
      }, port ? 400 : 100);
    }
  };

  const inspectChunk = (chunk) => {
    lineBuffer += chunk.toString('utf8');
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      handleCompletedLine(line);
    }
  };

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    inspectChunk(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    inspectChunk(chunk);
  });

  const exitCode = await new Promise((resolveExit) => {
    child.on('exit', (code) => resolveExit(code ?? 0));
  });

  for (const t of tunnels) {
    try {
      t.kill('SIGTERM');
    } catch {}
  }

  if (exitCode === 0) {
    console.log(`\n[sovra-ssh-bakim] ${tool} girişi tamamlandı, canlı durum doğrulanıyor...\n`);
    await cmdStatus(host);
  } else {
    process.exit(exitCode);
  }
}

async function main() {
  const [sub, arg1, arg2] = process.argv.slice(2);
  if (!sub || sub === '-h' || sub === '--help' || sub === 'yardim') {
    usage();
    return;
  }
  if (sub === 'durum' || sub === 'status') {
    await cmdStatus(arg1 || DEFAULT_HOST);
  } else if (sub === 'guncelle' || sub === 'sync' || sub === 'update') {
    await cmdUpdate(arg1 || DEFAULT_HOST);
  } else if (sub === 'giris' || sub === 'login') {
    if (!arg1) {
      console.error('Kullanım: sovra-ssh-bakim giris <claude|agy|codex|kimi|grok> [host]');
      process.exit(1);
    }
    await cmdLogin(arg1.toLowerCase(), arg2 || DEFAULT_HOST);
  } else {
    console.error(`Bilinmeyen alt komut: ${sub}`);
    usage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Hata:', err?.message || err);
  process.exit(1);
});
