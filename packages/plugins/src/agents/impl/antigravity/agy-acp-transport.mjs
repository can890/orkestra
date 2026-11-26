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
// `_session/steering` yanıtındaki isteğe bağlı `queueReason` değerleri (core'daki QUEUE_REASONS ile
// aynı metinler): mesajın neden kuyrukta beklediğini kuyruk bandı söyler.
export const QUEUE_REASON = Object.freeze({
  connecting: 'connecting',
  antigravityOrchestrator: 'antigravity-orchestrator',
  antigravityStreamJson: 'antigravity-stream-json',
});
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
// Orkestratör modelleri (Planlayıcı + Uygulayıcı) stream-json'da kalır. Ölçüm (agy 1.5.17,
// transcript_full.jsonl'deki adım `model` alanı ve "Claude mu Gemini mi" kimlik sorusu; Claude
// modeli doğrudan seçilince "Claude", Gemini seçilince "Gemini" yanıtladı: run26/run24):
// - stream-json: adımlar kullanıcının agy'de kayıtlı rollerinde çalışır (Planlayıcı
//   `gemini-4-neon-high`, Uygulayıcı `gemini-4-hydrogen-high`); oturuma özel
//   `--settings {"orchestrator":…}` bunu değiştirmez (run19/run25/run28; Claude Planlayıcı
//   istenince yanıt yine "Gemini": run24).
// - agy acp: `--settings` de yok sayılır (run12/run27) ve orkestratör başka rollerle çalışır:
//   Planlayıcı adımı `gemini-pro-orchestrator`, Uygulayıcı `gemini-flash-worker-agy` (run13).
// agy acp'ye geçmek kullanıcının kayıtlı rollerini bu yüzden sessizce değiştirirdi.
export function streamJsonOnlyReason(session, { isOrchestratorModel }) {
  if (isOrchestratorModel(session?.model)) return 'orchestrator';
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
// İzin isteğindeki aracın `sunucu/araç` çifti (MCP çağrısı değilse undefined). Ölçülen biçim
// (agy acp 1.5.17, global mcp_config.json'daki sunucu, r01/r03): `name: "call_mcp_tool"`,
// `rawInput: { ServerName, ToolName, Arguments }` (tırnaksız). `session/new` ile verilen sunucular
// ise `mcp_<sunucu>_<araç>` adıyla, argümansız gelir; adaptör onları kullanmaz.
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
  const name =
    typeof update?.name === 'string' && update.name
      ? update.name
      : typeof update?.title === 'string' && update.title
        ? update.title
        : known.name;
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

// --- agy'nin yerleşik alt ajanları (invoke_subagent) ---------------------------------------------
// Ölçüm (agy 1.5.17, /tmp/orkestra-dalga2/agy-alt-ajan-capture r02/r04/r05):
// - `invoke_subagent` ACP'de sıradan bir araç satırıdır (`name`, `rawInput` Prompt/Role/TypeName);
//   tamamlanması yalnızca "başlatıldı" demektir ve çıktısı (konuşma kimliği) akışta yoktur.
// - Alt ajanın konuşma kimliği üst konuşmanın `brain/<üst>/.system_generated/subagents/<id>.json`
//   dosyasıyla, alt ajana giden ilk mesaj (`brain/<id>/.system_generated/messages/*.json`) ise
//   `sourceMetadata.tool.toolCall.id` alanında bu ACP araç kimliğini taşır.
// - Alt ajanın kendi araç çağrıları üst oturumun akışında `<alt-konuşma-kimliği>:<çağrı>` kimliğiyle
//   görünür (yalnızca onay gerektiğinde, izin isteğiyle birlikte).
// - agy üst turu alt ajanlar bitene dek açık tutar; bitişte üst konuşmaya "Subagent <id> has gone
//   idle" ya da yanıt mesajı, iptalde "Subagent \"<id>\" has been explicitly canceled" gelir.
const SUBAGENT_CALL_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):./i;
// Bir alt ajanın kendi araç çağrısıysa o alt ajanın konuşma kimliği.
export function subagentOfToolCallId(toolCallId) {
  const match = typeof toolCallId === 'string' ? SUBAGENT_CALL_ID.exec(toolCallId) : null;
  return match ? match[1].toLowerCase() : undefined;
}
// `invoke_subagent` sonucundaki "Created the following subagent: {...}" bloğu.
export function parseCreatedSubagent(content) {
  if (typeof content !== 'string') return undefined;
  const match = /Created the following subagent:\s*(\{[\s\S]*?\n\})/.exec(content);
  if (!match) return undefined;
  try {
    const data = JSON.parse(match[1]);
    const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : '';
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return undefined;
    return {
      conversationId: conversationId.toLowerCase(),
      logUri: typeof data.logAbsoluteUri === 'string' ? data.logAbsoluteUri : undefined,
    };
  } catch {
    return undefined;
  }
}
// agy'nin üst konuşmaya bıraktığı "alt ajan durduruldu" sistem mesajı bu alt ajan için mi? İki biçim
// ölçüldü: tek alt ajan (`Subagent "<id>" has been explicitly canceled by the user`, izin
// reddinde de: r04) ve üst turun durdurulması (`All your subagents and background tasks have been
// stopped due to user force cancellation`, kimliksiz: r08). İkincisi yalnızca ondan önce başlamış
// alt ajanlar içindir (`since`: alt ajanın başlangıcı, ms).
export function isSubagentCancelledMessage(message, conversationId, since = 0) {
  if (!message || typeof message !== 'object' || !conversationId) return false;
  const content = typeof message.content === 'string' ? message.content : '';
  if (message.sender === 'system' && /\bAll your subagents\b[\s\S]*\bstopped\b/i.test(content)) {
    const at = Date.parse(message.timestamp ?? '');
    return !Number.isFinite(at) || at >= since;
  }
  if (!content.toLowerCase().includes(conversationId.toLowerCase())) return false;
  return /\bSubagent\b[\s\S]*\bcancel+ed\b/i.test(content);
}
// Alt ajana giden ilk mesaj bu ACP araç çağrısından mı geldi? (kimlik; yoksa aynı görev metni)
export function isSpawnMessageOf(message, { acpToolCallId, prompt }) {
  const call = message?.sourceMetadata?.tool?.toolCall;
  if (!call || typeof call !== 'object') return false;
  if (acpToolCallId && call.id === acpToolCallId) return true;
  if (call.name !== 'invoke_subagent' || !prompt) return false;
  return typeof message.content === 'string' && message.content.trim() === prompt.trim();
}

// Alt ajanlarla ilgili agy araç satırlarının Türkçe başlıkları (ham araç adı yerine).
export function subagentToolTitle(name, args) {
  const arg = (key) => unquote(args?.[key]);
  switch (name) {
    case 'manage_subagents': {
      const action = arg('Action').toLowerCase();
      return action === 'list' ? 'Alt ajanlar listelendi' : `Alt ajanlar: ${action || 'yönetim'}`;
    }
    case 'send_message':
      return 'Alt ajana mesaj gönderildi';
    case 'schedule': {
      const seconds = Number(unquote(String(args?.DurationSeconds ?? '')));
      const prompt = arg('Prompt');
      const head =
        Number.isFinite(seconds) && seconds > 0 ? `Bekleniyor (${seconds} sn)` : 'Bekleniyor';
      return prompt ? `${head}: ${prompt}` : head;
    }
    case 'call_mcp_tool':
      return arg('ToolName') === 'list_subagent_models'
        ? 'Alt ajan modelleri listelendi'
        : undefined;
    default:
      return undefined;
  }
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
