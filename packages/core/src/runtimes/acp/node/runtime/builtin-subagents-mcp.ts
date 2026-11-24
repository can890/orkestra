import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerRegistration } from '#primitives/mcp/api';

export const BUILTIN_SUBAGENTS_MCP_NAME = 'orkestra-subagents';
export const BUILTIN_SUBAGENTS_BRIDGE_FILENAME = 'orkestra-subagents-mcp.mjs';

export interface ResolveBuiltinSubagentsBridgeOptions {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}

export const SUBAGENTS_MCP_BRIDGE_SOURCE = String.raw`import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const STATE_DIR =
  process.env.ORKESTRA_SUBAGENTS_DIR || join(homedir(), '.local', 'state', 'orkestra', 'subagents');

const CLAUDE_MODELS = [
  { slug: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: ['low', 'medium', 'high'] },
  { slug: 'claude-opus-5', name: 'Claude Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-fable-5', name: 'Claude Fable 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'max'] },
];

const FALLBACK_AGY_MODELS = [
  { slug: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { slug: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
  { slug: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
  { slug: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
  { slug: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
  { slug: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  { slug: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
  { slug: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
  { slug: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
  { slug: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
  { slug: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
  { slug: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { slug: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { slug: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
  { slug: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { slug: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
  { slug: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { slug: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  { slug: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
  { slug: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
  { slug: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
  { slug: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
  { slug: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
];

const FALLBACK_CODEX_MODELS = [
  { slug: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

const FALLBACK_KIMI_MODELS = [
  { slug: 'kimi-code/k3', name: 'Kimi K3', efforts: ['low', 'high', 'max'] },
  { slug: 'kimi-code/kimi-for-coding', name: 'Kimi K2.8 Preview', efforts: ['low', 'high', 'max'] },
  { slug: 'kimi-code/kimi-for-coding-highspeed', name: 'Kimi K2.7 Code Highspeed', efforts: ['low', 'high'] },
];

const GROK_MODELS = [
  { slug: 'grok-4.7', name: 'Grok 4.7' },
  { slug: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' },
  { slug: 'grok-4.6', name: 'Grok 4.6' },
  { slug: 'grok-4.5', name: 'Grok 4.5' },
];

const GEMINI_MODELS = [
  { slug: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { slug: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
];

const ALL_PROVIDERS = ['antigravity', 'codex', 'claude', 'kimi', 'grok', 'gemini'];

const TOOLS = [
  {
    name: 'list_subagent_models',
    description:
      'Sistemde kurulu tüm yapay zeka sağlayıcılarını (antigravity, codex, claude, kimi, grok, gemini) ve kullanılabilir model + efor listesini döner.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ALL_PROVIDERS,
          description: 'İsteğe bağlı: yalnızca tek bir sağlayıcının modellerini listeler.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_subagent',
    description:
      'İstenen herhangi bir yapay zeka sağlayıcısı (antigravity, codex, claude, kimi, grok, gemini), özel model (örn. gemini-4-hydrogen-medium, gemini-4-carbon-high, gpt-6-astra, gpt-5.6-sol, kimi-code/k3, claude-opus-5-5, grok-4.7) ve efor seviyesi (low, medium, high, xhigh, max) ile gerçek bir alt ajan çalıştırır ve sonucunu döndürür. Kullanıcı belirli bir model, efor veya harici yapay zeka (Codex, Claude, Kimi, Grok, Gemini) istediğinde yerleşik invoke_subagent yerine MUTLAKA bu aracı kullan. Birden fazla alt ajan istendiğinde paralel çağırabilirsin.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ALL_PROVIDERS,
          description:
            'Alt ajanı çalıştıracak sağlayıcı (antigravity, codex, claude, kimi, grok, gemini). Belirtilmezse model adından otomatik seçilir.',
        },
        model: {
          type: 'string',
          description:
            'Model slug veya doğal adı (örn. "gemini-4-hydrogen-medium", "hydrogen", "gpt-5.6-sol", "kimi-code/k3", "kimi k3", "claude-opus-5-5", "grok-4.7").',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Düşünme/muhakeme efor seviyesi (low, medium, high, xhigh, max).',
        },
        role: {
          type: 'string',
          description: 'Alt ajanın sağ panelde görünecek kısa rol/başlık adı (örn. "Hydrogen Analizci", "Kimi K3").',
        },
        prompt: {
          type: 'string',
          description: 'Alt ajana verilecek görev/prompt metni.',
        },
        cwd: {
          type: 'string',
          description: 'Çalışma dizini (belirtilmezse mevcut çalışma dizini kullanılır).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function writeRunState(runId, state) {
  try {
    ensureStateDir();
    const target = join(STATE_DIR, runId + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, target);
  } catch {
    /* ignore */
  }
}

function truncate(text, max = 360) {
  if (typeof text !== 'string') return '';
  const cleaned = text.trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}

function resolveBinary(names) {
  const pathDirs = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.kimi-code', 'bin'),
    join(homedir(), '.grok', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean);
  for (const name of names) {
    if (name.includes('/') && existsSync(name)) return name;
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function fetchAgyModels() {
  return new Promise((resolve) => {
    const bin = resolveBinary([process.env.ORKESTRA_AGY_EXECUTABLE || 'agy', 'agy']);
    if (!bin) return resolve(FALLBACK_AGY_MODELS);
    execFile(bin, ['models'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(FALLBACK_AGY_MODELS);
      const list = stdout
        .split('\n')
        .map((l) => l.trim().split(/\t+/))
        .filter((p) => p.length >= 2 && /^[a-z0-9][a-z0-9._-]+$/.test(p[0]))
        .map(([slug, name]) => ({ slug, name }));
      resolve(list.length ? list : FALLBACK_AGY_MODELS);
    });
  });
}

function fetchCodexModels() {
  try {
    const cachePath = join(homedir(), '.codex', 'models_cache.json');
    if (!existsSync(cachePath)) return FALLBACK_CODEX_MODELS;
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    const models = Array.isArray(raw) ? raw : raw?.models || [];
    const visible = models
      .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list')
      .map((m) => ({
        slug: m.slug,
        name: m.display_name || m.slug,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.map((r) => r.effort).filter(Boolean)
          : ['low', 'medium', 'high', 'xhigh', 'max'],
      }));
    return visible.length ? visible : FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}

function fetchKimiModels() {
  try {
    const cfgPath = join(homedir(), '.kimi-code', 'config.toml');
    if (!existsSync(cfgPath)) return FALLBACK_KIMI_MODELS;
    const text = readFileSync(cfgPath, 'utf8');
    const results = [];
    const sections = text.split(/^\[models\."([^"]+)"\]/gm);
    for (let i = 1; i < sections.length; i += 2) {
      const slug = sections[i];
      const body = sections[i + 1] || '';
      const dnMatch = /display_name\s*=\s*"([^"]+)"/.exec(body);
      const effMatch = /support_efforts\s*=\s*\[([^\]]*)\]/.exec(body);
      const efforts = effMatch
        ? effMatch[1]
            .split(',')
            .map((s) => s.replace(/["'\s]/g, ''))
            .filter(Boolean)
        : undefined;
      results.push({
        slug,
        name: dnMatch ? 'Kimi ' + dnMatch[1] : slug,
        ...(efforts?.length ? { efforts } : {}),
      });
    }
    return results.length ? results : FALLBACK_KIMI_MODELS;
  } catch {
    return FALLBACK_KIMI_MODELS;
  }
}

function normalizeEffort(effort) {
  if (!effort || typeof effort !== 'string') return undefined;
  const e = effort.trim().toLowerCase();
  if (['low', 'düşük', 'dusuk'].includes(e)) return 'low';
  if (['medium', 'orta', 'med'].includes(e)) return 'medium';
  if (['high', 'yüksek', 'yuksek'].includes(e)) return 'high';
  if (['xhigh', 'extra-high', 'çok yüksek', 'cok yuksek'].includes(e)) return 'xhigh';
  if (['max', 'maks', 'ultra'].includes(e)) return 'max';
  return undefined;
}

function inferProvider(providerArg, modelArg) {
  if (ALL_PROVIDERS.includes(providerArg)) {
    return providerArg;
  }
  const m = (modelArg || '').toLowerCase();
  if (/(kimi|k3|k2\.8|k2\.7)/.test(m)) return 'kimi';
  if (/(grok)/.test(m)) return 'grok';
  if (/(codex|gpt[\s-]|astra|terra|luna|\bsol\b|^o[1-9])/.test(m)) return 'codex';
  if (/(claude|opus|sonnet|haiku|fable|mythos)/.test(m)) {
    // If model explicitly has Antigravity effort suffix (-low/-medium/-high), route to Antigravity
    if (/-(low|medium|high|thinking)$/.test(m)) return 'antigravity';
    return resolveBinary(['claude']) ? 'claude' : 'antigravity';
  }
  if (/gemini-2\./.test(m) && resolveBinary(['gemini'])) return 'gemini';
  return 'antigravity';
}

function resolveModelSlug(provider, modelArg, effort, catalog) {
  const raw = (modelArg || '').trim().toLowerCase();
  if (!raw) {
    return (
      catalog[0]?.slug ||
      (provider === 'codex'
        ? 'gpt-5.6-sol'
        : provider === 'kimi'
          ? 'kimi-code/k3'
          : provider === 'claude'
            ? 'claude-sonnet-5-5'
            : provider === 'grok'
              ? 'grok-4.7'
              : 'gemini-4-hydrogen-medium')
    );
  }
  const exact = catalog.find((m) => m.slug.toLowerCase() === raw);
  if (exact) {
    if (provider === 'antigravity' && effort) {
      const base = exact.slug.replace(/-(low|medium|high|xhigh)$/i, '');
      const variant = catalog.find((m) => m.slug.toLowerCase() === base + '-' + effort);
      if (variant) return variant.slug;
    }
    return exact.slug;
  }
  const normalized = raw
    .replace(/hidrojen/g, 'hydrogen')
    .replace(/karbon/g, 'carbon')
    .replace(/yüksek|yuksek/g, 'high')
    .replace(/orta/g, 'medium')
    .replace(/düşük|dusuk/g, 'low');
  const tokens = normalized.split(/[\s_/,-]+/).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const item of catalog) {
    const hay = (item.slug + ' ' + (item.name || '')).toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += tok.length >= 4 ? 3 : 2;
    }
    if (effort && hay.includes(effort)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best && bestScore >= 2) return best.slug;
  return modelArg.trim();
}

function formatModelLabel(slug) {
  if (!slug) return '';
  const stripped = slug.replace(/^kimi-code\//i, '').replace(/-(low|medium|high|xhigh|max)$/i, '');
  if (/^k3$/i.test(stripped)) return 'Kimi K3';
  if (/^kimi-for-coding$/i.test(stripped)) return 'Kimi K2.8 Preview';
  if (/^kimi-for-coding-highspeed$/i.test(stripped)) return 'Kimi K2.7 Highspeed';
  return stripped
    .split('-')
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function extractEffortFromSlug(slug) {
  const match = /-(low|medium|high|xhigh|max)$/i.exec(slug || '');
  return match ? match[1].toLowerCase() : undefined;
}

function providerTitle(provider) {
  const map = {
    antigravity: 'Antigravity',
    codex: 'Codex',
    claude: 'Claude',
    kimi: 'Kimi',
    grok: 'Grok',
    gemini: 'Gemini',
  };
  return map[provider] || provider;
}

async function executeSubagent(args) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) throw new Error('prompt alanı zorunludur.');
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : process.cwd();
  const provider = inferProvider(args.provider, args.model);
  const effort = normalizeEffort(args.effort);

  const catalog =
    provider === 'antigravity'
      ? await fetchAgyModels()
      : provider === 'codex'
        ? fetchCodexModels()
        : provider === 'kimi'
          ? fetchKimiModels()
          : provider === 'grok'
            ? GROK_MODELS
            : provider === 'gemini'
              ? GEMINI_MODELS
              : CLAUDE_MODELS;

  const modelSlug = resolveModelSlug(provider, args.model, effort, catalog);
  const effectiveEffort = effort || extractEffortFromSlug(modelSlug);
  const modelLabel = formatModelLabel(modelSlug);
  const role =
    (typeof args.role === 'string' && args.role.trim()) ||
    providerTitle(provider) + ' Alt Ajan';

  const runId = randomUUID();
  const startedAt = Date.now();
  const activities = [];
  const state = {
    runId,
    provider,
    modelSlug,
    model: modelLabel,
    effort: effectiveEffort,
    role,
    prompt,
    cwd,
    status: 'in_progress',
    startedAt,
    updatedAt: startedAt,
    summary: undefined,
    activities,
  };

  const pushActivity = (entry) => {
    activities.push({ ...entry, timestamp: Date.now() });
    if (activities.length > 40) activities.splice(0, activities.length - 40);
    state.updatedAt = Date.now();
    writeRunState(runId, state);
  };

  writeRunState(runId, state);

  let cmd;
  let cliArgs;
  let stdinPayload = null;

  if (provider === 'antigravity') {
    cmd = resolveBinary([process.env.ORKESTRA_AGY_EXECUTABLE || 'agy', 'agy']);
    if (!cmd) throw new Error('agy CLI bulunamadı.');
    cliArgs = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      modelSlug,
      '--dangerously-skip-permissions',
    ];
    if (effectiveEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effectiveEffort)) {
      cliArgs.push('--effort', effectiveEffort);
    }
    stdinPayload = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
  } else if (provider === 'codex') {
    cmd = resolveBinary(['codex']);
    if (!cmd) throw new Error('codex CLI bulunamadı.');
    cliArgs = [
      'exec',
      '--json',
      '-m',
      modelSlug,
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ];
    if (effectiveEffort) {
      cliArgs.push('-c', 'model_reasoning_effort="' + effectiveEffort + '"');
    }
    cliArgs.push('-');
    stdinPayload = prompt;
  } else if (provider === 'kimi') {
    cmd = resolveBinary(['kimi']);
    if (!cmd) throw new Error('kimi CLI bulunamadı.');
    cliArgs = ['-p', prompt, '-m', modelSlug, '--output-format', 'stream-json'];
  } else if (provider === 'grok') {
    cmd = resolveBinary(['grok']);
    if (!cmd) throw new Error('grok CLI bulunamadı.');
    cliArgs = ['-p', prompt, '-m', modelSlug, '--output-format', 'stream-json', '--always-approve'];
  } else if (provider === 'gemini') {
    cmd = resolveBinary(['gemini']);
    if (!cmd) throw new Error('gemini CLI bulunamadı.');
    cliArgs = ['-p', prompt, '-m', modelSlug, '--output-format', 'stream-json', '--yolo'];
  } else {
    cmd = resolveBinary(['claude']);
    if (!cmd) throw new Error('claude CLI bulunamadı.');
    cliArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      modelSlug,
      '--dangerously-skip-permissions',
    ];
    if (effectiveEffort && ['low', 'medium', 'high', 'max'].includes(effectiveEffort)) {
      cliArgs.push('--effort', effectiveEffort);
    }
    cliArgs.push(prompt);
  }

  pushActivity({
    id: 'start-0',
    kind: 'status',
    title: modelLabel + (effectiveEffort ? ' (' + effectiveEffort + ')' : '') + ' başlatıldı',
    status: 'running',
  });

  return new Promise((resolve) => {
    const child = spawn(cmd, cliArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let finalResponse = '';
    let stderrBuf = '';
    let errorMessage = '';
    let stepSeq = 0;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        if (provider === 'kimi' || provider === 'grok' || provider === 'gemini') {
          finalResponse += (finalResponse ? '\n' : '') + trimmed;
        }
        return;
      }

      if (provider === 'antigravity') {
        if (ev.event === 'step_update' && ev.step_update) {
          const u = ev.step_update;
          if (u.step_type === 'tool') {
            pushActivity({
              id: 'tool-' + u.step_index + '-' + (++stepSeq),
              kind: 'tool',
              title: u.tool_name || 'Araç',
              detail: u.tool_info?.parameters ? truncate(JSON.stringify(u.tool_info.parameters), 200) : undefined,
              status: u.state === 'DONE' ? (u.tool_info?.error ? 'error' : 'done') : 'running',
            });
          } else if (u.step_type === 'agent_response' && u.text_delta) {
            finalResponse += u.text_delta;
          }
        } else if (ev.event === 'result' && ev.result) {
          if (ev.result.response) finalResponse = ev.result.response;
          if (ev.result.status !== 'SUCCESS') {
            errorMessage = ev.result.error || 'Antigravity alt ajanı tamamlanamadı.';
          }
        }
      } else if (provider === 'codex') {
        if (ev.type === 'item.completed' && ev.item) {
          const item = ev.item;
          if (item.type === 'agent_message' && item.text) {
            finalResponse = item.text;
            pushActivity({
              id: 'msg-' + (item.id || ++stepSeq),
              kind: 'message',
              title: 'Yanıt',
              detail: truncate(item.text, 320),
              status: 'done',
            });
          } else if (item.type === 'reasoning' && item.text) {
            pushActivity({
              id: 'think-' + (item.id || ++stepSeq),
              kind: 'thinking',
              title: 'Düşünüyor',
              detail: truncate(item.text, 240),
              status: 'done',
            });
          } else if (item.type === 'command_execution') {
            pushActivity({
              id: 'cmd-' + (item.id || ++stepSeq),
              kind: 'tool',
              title: 'Komut çalıştırıldı',
              detail: truncate(item.command || '', 220),
              status: item.exit_code && item.exit_code !== 0 ? 'error' : 'done',
            });
          } else if (item.type === 'error' && item.message && !item.message.includes('fallback metadata')) {
            pushActivity({
              id: 'err-' + (item.id || ++stepSeq),
              kind: 'error',
              title: 'Uyarı',
              detail: truncate(item.message, 240),
              status: 'error',
            });
          }
        } else if (ev.type === 'item.started' && ev.item && ev.item.type === 'command_execution') {
          pushActivity({
            id: 'cmd-start-' + (ev.item.id || ++stepSeq),
            kind: 'tool',
            title: 'Komut çalıştırılıyor',
            detail: truncate(ev.item.command || '', 220),
            status: 'running',
          });
        } else if (ev.type === 'turn.failed' && ev.error?.message) {
          errorMessage = ev.error.message;
        } else if (ev.type === 'error' && ev.message) {
          errorMessage = ev.message;
        }
      } else if (provider === 'kimi') {
        if (ev.role === 'assistant') {
          if (typeof ev.content === 'string' && ev.content.trim()) {
            finalResponse = ev.content;
            pushActivity({
              id: 'kimi-msg-' + (++stepSeq),
              kind: 'message',
              title: 'Yanıt',
              detail: truncate(ev.content, 320),
              status: 'done',
            });
          } else if (Array.isArray(ev.content)) {
            for (const part of ev.content) {
              if (part?.type === 'think' && part.think) {
                pushActivity({
                  id: 'kimi-think-' + (++stepSeq),
                  kind: 'thinking',
                  title: 'Düşünüyor',
                  detail: truncate(part.think, 240),
                  status: 'done',
                });
              } else if (part?.type === 'text' && part.text) {
                finalResponse = part.text;
                pushActivity({
                  id: 'kimi-msg-' + (++stepSeq),
                  kind: 'message',
                  title: 'Yanıt',
                  detail: truncate(part.text, 320),
                  status: 'done',
                });
              }
            }
          }
          if (Array.isArray(ev.tool_calls)) {
            for (const tc of ev.tool_calls) {
              pushActivity({
                id: 'kimi-tool-' + (tc.id || ++stepSeq),
                kind: 'tool',
                title: tc.function?.name || tc.name || 'Araç',
                detail: tc.function?.arguments ? truncate(String(tc.function.arguments), 200) : undefined,
                status: 'done',
              });
            }
          }
        } else if (ev.type === 'error' && (ev.message || ev.error)) {
          errorMessage = String(ev.message || ev.error);
        }
      } else if (provider === 'claude' || provider === 'grok' || provider === 'gemini') {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              finalResponse = block.text;
              pushActivity({
                id: 'msg-' + (++stepSeq),
                kind: 'message',
                title: 'Yanıt',
                detail: truncate(block.text, 320),
                status: 'done',
              });
            } else if (block.type === 'thinking' && block.thinking) {
              pushActivity({
                id: 'think-' + (++stepSeq),
                kind: 'thinking',
                title: 'Düşünüyor',
                detail: truncate(block.thinking, 240),
                status: 'done',
              });
            } else if (block.type === 'tool_use') {
              pushActivity({
                id: 'tool-' + (block.id || ++stepSeq),
                kind: 'tool',
                title: block.name || 'Araç',
                detail: block.input ? truncate(JSON.stringify(block.input), 200) : undefined,
                status: 'running',
              });
            }
          }
        } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
          finalResponse += ev.content;
        } else if (ev.type === 'result') {
          if (typeof ev.result === 'string' && ev.result) finalResponse = ev.result;
          if (ev.is_error) errorMessage = ev.result || (providerTitle(provider) + ' alt ajanı hata verdi.');
        } else if (ev.type === 'error' && (ev.message || ev.error)) {
          errorMessage = String(ev.message || ev.error);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on('error', (err) => {
      state.status = 'failed';
      state.summary = err.message;
      state.completedAt = Date.now();
      writeRunState(runId, state);
      resolve({
        ok: false,
        runId,
        provider,
        model: modelLabel,
        modelSlug,
        effort: effectiveEffort,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      let errText = errorMessage || (code !== 0 && !finalResponse.trim() ? stderrBuf : '');
      if (provider === 'claude' && /OAuth session expired|Failed to authenticate/i.test(errText + finalResponse)) {
        errText =
          'Claude CLI oturum süresi dolmuş (terminalde "claude /login" ile yenilenebilir; ya da provider="antigravity" ile Claude Opus/Sonnet 5.5 çalıştırılabilir).';
      }
      const failed = Boolean(errText) || (code !== 0 && !finalResponse.trim());
      state.status = failed ? 'failed' : 'completed';
      state.completedAt = Date.now();
      state.summary = failed
        ? truncate(errText || ('Çıkış kodu: ' + code), 360)
        : truncate(finalResponse || 'Alt ajan tamamlandı.', 360);
      if (failed) {
        pushActivity({
          id: 'err-final-' + (++stepSeq),
          kind: 'error',
          title: 'Hata',
          detail: state.summary,
          status: 'error',
        });
      } else if ((provider === 'antigravity' || provider === 'gemini') && finalResponse.trim()) {
        pushActivity({
          id: 'resp-final-' + (++stepSeq),
          kind: 'message',
          title: 'Yanıt',
          detail: truncate(finalResponse, 360),
          status: 'done',
        });
      } else {
        writeRunState(runId, state);
      }
      resolve({
        ok: !failed,
        runId,
        provider,
        model: modelLabel,
        modelSlug,
        effort: effectiveEffort,
        role,
        durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        response: finalResponse.trim(),
        ...(failed ? { error: state.summary } : {}),
      });
    });

    child.stdin.on('error', () => {});
    if (stdinPayload !== null) {
      child.stdin.end(stdinPayload);
    } else {
      child.stdin.end();
    }
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === 'notifications/initialized' || id === undefined) return;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orkestra-subagents', version: '1.1.0' },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === 'list_subagent_models') {
        const result = {};
        if (!args.provider || args.provider === 'antigravity') {
          result.antigravity = {
            installed: Boolean(resolveBinary([process.env.ORKESTRA_AGY_EXECUTABLE || 'agy', 'agy'])),
            models: await fetchAgyModels(),
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          };
        }
        if (!args.provider || args.provider === 'codex') {
          result.codex = {
            installed: Boolean(resolveBinary(['codex'])),
            models: fetchCodexModels(),
          };
        }
        if (!args.provider || args.provider === 'claude') {
          result.claude = {
            installed: Boolean(resolveBinary(['claude'])),
            models: CLAUDE_MODELS,
          };
        }
        if (!args.provider || args.provider === 'kimi') {
          result.kimi = {
            installed: Boolean(resolveBinary(['kimi'])),
            models: fetchKimiModels(),
          };
        }
        if (!args.provider || args.provider === 'grok') {
          result.grok = {
            installed: Boolean(resolveBinary(['grok'])),
            models: GROK_MODELS,
          };
        }
        if (!args.provider || args.provider === 'gemini') {
          result.gemini = {
            installed: Boolean(resolveBinary(['gemini'])),
            models: GEMINI_MODELS,
          };
        }
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
        return;
      }
      if (name === 'run_subagent') {
        const outcome = await executeSubagent(args);
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: !outcome.ok,
            content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
          },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Bilinmeyen araç: ' + String(name) },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Desteklenmeyen yöntem: ' + String(method) },
    });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      },
    });
  }
});
`;

function resolveSubagentsStateDir(options: ResolveBuiltinSubagentsBridgeOptions = {}): string {
  if (options.stateDir) return options.stateDir;
  const env = options.env ?? process.env;
  if (env.ORKESTRA_STATE_DIR?.trim()) {
    return join(env.ORKESTRA_STATE_DIR.trim(), 'mcp');
  }
  const home = env.HOME || homedir() || tmpdir();
  return join(home, '.local', 'state', 'orkestra', 'mcp');
}

export function materializeBuiltinSubagentsBridge(
  options: ResolveBuiltinSubagentsBridgeOptions = {}
): string {
  const dir = resolveSubagentsStateDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, BUILTIN_SUBAGENTS_BRIDGE_FILENAME);
  let current: string | null = null;
  if (existsSync(target)) {
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
  }
  if (current !== SUBAGENTS_MCP_BRIDGE_SOURCE) {
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, SUBAGENTS_MCP_BRIDGE_SOURCE, { mode: 0o600 });
    renameSync(temp, target);
  }
  return target;
}

export function buildBuiltinSubagentsMcpRegistration(
  options: ResolveBuiltinSubagentsBridgeOptions = {}
): McpServerRegistration {
  const bridgePath = materializeBuiltinSubagentsBridge(options);
  return {
    name: BUILTIN_SUBAGENTS_MCP_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: [bridgePath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
    },
    enabled: true,
  };
}

export async function resolveBuiltinSubagentsMcpRegistration(
  options: ResolveBuiltinSubagentsBridgeOptions = {}
): Promise<McpServerRegistration> {
  return buildBuiltinSubagentsMcpRegistration(options);
}

export function mergeWithBuiltinSubagentsMcp(
  registrations: readonly McpServerRegistration[],
  builtin: McpServerRegistration = buildBuiltinSubagentsMcpRegistration()
): McpServerRegistration[] {
  const index = registrations.findIndex((entry) => entry.name === BUILTIN_SUBAGENTS_MCP_NAME);
  if (index === -1) {
    return [...registrations, builtin];
  }
  const existing = registrations[index]!;
  if (existing.enabled === false) {
    return [...registrations];
  }
  const next = [...registrations];
  next[index] = {
    ...existing,
    ...builtin,
    env: {
      ...(existing.env ?? {}),
      ...(builtin.env ?? {}),
      ELECTRON_RUN_AS_NODE: '1',
    },
    enabled: true,
  };
  return next;
}
