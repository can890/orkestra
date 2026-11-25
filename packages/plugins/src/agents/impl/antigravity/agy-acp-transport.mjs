// agy'nin yerel ACP sunucusu (`agy acp`) için iç taşıma katmanı.
//
// Neden: stream-json modunda agy, çalışan tur sırasında yazılan ikinci `user` satırını ancak turun
// `result` olayından sonra okur (agy 1.5.17, `queuedMessages: send-immediately` ile de). `agy acp`
// ise aynı oturuma tur sürerken gelen ikinci `session/prompt` isteğini çalışan tura katar: agy
// mesajı o anki adımdan sonra okur, çalışan komutu kesmez, arka plan görevi beklerken de çalışır;
// ilk istek hemen `end_turn` ile döner ve işin geri kalanı ikinci isteğin altında akar
// (yakalamalar: /tmp/orkestra-dalga2/agy-capture/run7, run8, run11).
//
// Bu dosya yalnızca bağımsız yardımcıları içerir; oturum ve tur yönetimi acp-adapter.mjs'tedir.
import { createInterface } from 'node:readline';

export const AGY_TRANSPORT_ENV = 'ORKESTRA_AGY_TRANSPORT';
export const ACP_PROBE_TIMEOUT_MS = 15_000;
// Yönlendirilen mesajın kabul işareti: agy mesajı aldığında önceki istek hemen döner. Bu süre içinde
// işaret gelmezse mesaj yine de agy'de kalır (kaybolmaz, ikinci kez gönderilmez).
export const STEER_ACCEPT_TIMEOUT_MS = 5_000;
// Stop sonrası agy turu bu sürede kapatmazsa süreç sonlandırılır.
export const ACP_CANCEL_GRACE_MS = 10_000;

// `auto` (varsayılan: agy acp destekliyorsa acp), `acp` ya da `stream-json`.
export function normalizeTransport(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'acp') return 'acp';
  if (raw === 'stream-json' || raw === 'streamjson' || raw === 'stream_json') return 'stream-json';
  return 'auto';
}

// Bu oturumun açılışı yalnızca stream-json'un yapabildiği bir şeye ihtiyaç duyuyorsa nedenini döner.
// Orkestratör Planlayıcı/Uygulayıcı seçimleri `--settings {"orchestrator":…}` ile gider; `agy acp`
// genel `--settings` bayrağını kabul ediyor ama orkestratör rollerine ulaştığı doğrulanamadı
// (agy 1.5.17, run12/run13: transcript ve günlük kullanılan rol modellerini göstermiyor).
export function streamJsonOnlyReason(session, { isOrchestratorModel, normalizeOrchestrator }) {
  if (isOrchestratorModel(session?.model) && normalizeOrchestrator(session?.orchestrator))
    return 'orchestrator-roles';
  return null;
}

// `agy [--settings <json>] acp [--dangerously-skip-permissions]`: `--settings` yalnızca alt
// komuttan önce kabul edilir.
export function buildAcpArgs(session, settings) {
  const args = [];
  if (settings && typeof settings === 'object' && Object.keys(settings).length > 0)
    args.push('--settings', JSON.stringify(settings));
  args.push('acp');
  if (session?.mode === 'auto') args.push('--dangerously-skip-permissions');
  return args;
}

// Uygulamanın kendi MCP araçları izin kipinden bağımsız olarak onaylanır (stream-json'da
// `permissions.allow` ile yapılanın karşılığı).
const BUILTIN_TOOLS = {
  'orkestra-subagents': new Set(['list_subagent_models', 'run_subagent']),
  'orkestra-widgets': new Set(['show_widget']),
};
function unquote(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      /* düz metin olarak kullan */
    }
  }
  return trimmed;
}
// İzin isteğindeki aracın `sunucu/araç` çifti (MCP çağrısı değilse undefined).
export function mcpToolOfPermission(params) {
  const call = params?.toolCall ?? {};
  const args = call.rawInput ?? call.args ?? {};
  const name = unquote(call.name);
  let server = unquote(args.ServerName ?? args.server_name ?? args.serverName);
  let tool = unquote(args.ToolName ?? args.tool_name ?? args.toolName);
  if (!tool && name && name !== 'call_mcp_tool') {
    const match = /^(?:mcp__)?([^/:]+?)(?:__|[/:])([^/:]+)$/.exec(name);
    if (match) {
      server = server || match[1];
      tool = match[2];
    }
  }
  if (!tool) {
    const title = unquote(call.title);
    const match = /([\w.-]+)[/:]([\w.-]+)\s*$/.exec(title);
    if (match) {
      server = server || match[1];
      tool = match[2];
    }
  }
  return tool ? { server, tool } : undefined;
}
export function isBuiltinMcpPermission(params, mcpServers) {
  const target = mcpToolOfPermission(params);
  if (!target) return false;
  for (const [server, tools] of Object.entries(BUILTIN_TOOLS)) {
    if (!tools.has(target.tool)) continue;
    if (target.server && target.server !== server) continue;
    const config = mcpServers?.[server];
    if (config && !config.disabled) return true;
  }
  return false;
}
// İzin isteğine verilecek yanıt. `default` kipte stream-json'daki gibi: ek onay isteyen araç
// sohbet modunda çalıştırılmaz (reddedilir ve tur sonunda söylenir).
export function permissionResponse(params, { allow }) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const pick = (kinds) => options.find((option) => kinds.includes(option?.kind));
  const chosen = allow
    ? pick(['allow_once', 'allow_always'])
    : pick(['reject_once', 'reject_always']);
  if (chosen?.optionId) return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}
export function permissionToolName(params) {
  const mcp = mcpToolOfPermission(params);
  if (mcp) return mcp.tool;
  const call = params?.toolCall ?? {};
  return unquote(call.name) || unquote(call.title) || 'araç';
}

// ACP araç güncellemesini stream-json `step_update` biçimine çevirir; böylece alt ajan, swarm,
// arka plan ve izin satırları stream-json ile aynı kodla üretilir. `known` önceki bilgileri taşır
// (agy her güncellemede adı ve argümanları yineler ama ACP buna zorlamaz).
export function acpToolStep(update, known = {}) {
  const name = typeof update?.name === 'string' && update.name ? update.name : known.name;
  const args = update?.rawInput ?? update?.args ?? known.args;
  const status = update?.status ?? known.status;
  const done = status === 'completed' || status === 'failed';
  let output;
  const raw = update?.rawOutput;
  if (typeof raw === 'string') output = raw;
  else if (raw && typeof raw === 'object' && typeof raw.output === 'string') output = raw.output;
  else if (Array.isArray(update?.content)) {
    const text = update.content
      .map((item) =>
        item?.type === 'content' && item.content?.type === 'text' ? item.content.text : ''
      )
      .filter(Boolean)
      .join('\n');
    if (text) output = text;
  }
  let error;
  if (status === 'failed') {
    error =
      (raw && typeof raw === 'object' && (raw.error || raw.message)) ||
      output ||
      'Araç başarısız oldu.';
  }
  return {
    name,
    args,
    status,
    step: {
      step_type: 'tool',
      state: done ? 'DONE' : 'ACTIVE',
      tool_name: name,
      tool_info: {
        ...(args !== undefined ? { parameters: args } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    },
  };
}

// Arka plan görevine dönen satırın ACP araç kimliği: tam bu komutu çalıştıran, henüz arka plan
// satırı olmayan ilk etkin araç.
export function acpToolForCommand(proc, command) {
  if (!command) return undefined;
  for (const [id, tool] of proc.activeTools) {
    if (tool.command === command && !proc.backgroundTasks.has(id)) return id;
  }
  return undefined;
}

// Satır tabanlı JSON-RPC istemcisi (agy acp alt sürecine).
export class AcpChildConnection {
  constructor(child, { onNotification = () => {}, onRequest, onClose = () => {} } = {}) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onClose = onClose;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    child.stdin?.on?.('error', () => {});
    child.stderr?.on?.('data', () => {});
  }
  receive(line) {
    if (line.length > 8 * 1024 * 1024) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.method === undefined && message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'agy acp isteği başarısız oldu.');
        error.code = message.error.code;
        error.data = message.error.data;
        waiter.reject(error);
      } else waiter.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id === undefined) {
      try {
        this.onNotification(message.method, message.params ?? {});
      } catch {
        /* bildirim işleme en iyi çabadır */
      }
      return;
    }
    void (async () => {
      let reply;
      try {
        const result = this.onRequest
          ? await this.onRequest(message.method, message.params ?? {})
          : undefined;
        if (result === undefined)
          reply = {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          };
        else reply = { jsonrpc: '2.0', id: message.id, result };
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error?.message || 'İstek işlenemedi.' },
        };
      }
      this.write(reply);
    })();
  }
  write(message) {
    if (this.closed) return false;
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch {
      return false;
    }
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('agy acp bağlantısı kapalı.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        reject(new Error('agy acp isteği yazılamadı.'));
      }
    });
  }
  notify(method, params) {
    return this.write({ jsonrpc: '2.0', method, params });
  }
  // Süreç kapandı: bekleyen her istek hata ile biter.
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.onClose(error);
  }
}

// `agy acp` başlıyor ve `initialize` isteğini yanıtlıyor mu? Hiçbir durumda fırlatmaz; uzak
// makinede agy yoksa, eskiyse ya da yanıt vermezse false döner.
export function probeAgyAcp({ cli, spawnProcess, timeoutMs = ACP_PROBE_TIMEOUT_MS, cwd }) {
  return new Promise((resolve) => {
    if (!cli) {
      resolve(false);
      return;
    }
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.stdin?.end?.();
      } catch {
        /* ignore */
      }
      try {
        child?.kill?.('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      child = spawnProcess(cli, ['acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        ...(cwd ? { cwd } : {}),
      });
    } catch {
      finish(false);
      return;
    }
    child.on?.('error', () => finish(false));
    child.on?.('close', () => finish(false));
    child.stderr?.on?.('data', () => {});
    child.stdin?.on?.('error', () => finish(false));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message?.id === 1)
          finish(Boolean(message.result && typeof message.result.agentCapabilities === 'object'));
      } catch {
        /* JSON olmayan satır: beklemeye devam */
      }
    });
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: 'orkestra-antigravity-probe', version: '1.0.0' },
          },
        }) + '\n'
      );
    } catch {
      finish(false);
    }
  });
}
