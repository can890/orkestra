import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'orkestra:agent-display-names:v1';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

/** Uygulamanın yeniden açılışını taklit eder: modül yeni bir örnek olarak yüklenir. */
async function freshModule() {
  vi.resetModules();
  return import('./agent-display-names');
}

describe('agent display names across launches', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('knows a custom agent name before metadata loads after a relaunch', async () => {
    const first = await freshModule();
    first.rememberAgentDisplayNames([
      { id: 'acp-local-h-zl-ajan', name: 'Hızlı Ajan' },
      { id: 'claude', name: 'Claude Code' },
    ]);

    const relaunched = await freshModule();
    // Meta veri henüz yüklenmedi: ad yine de ilk çizimde bilinir.
    expect(relaunched.agentDisplayName('acp-local-h-zl-ajan')).toBe('Hızlı Ajan');
    // Yalnızca kullanıcı ACP ajanları saklanır; yerleşik ajanlar kendi biçimini korur.
    expect(relaunched.agentDisplayName('claude')).toBeUndefined();
  });

  it('refreshes the stored name when the agent is renamed', async () => {
    const first = await freshModule();
    first.rememberAgentDisplayNames([{ id: 'acp-local-x', name: 'Eski Ad' }]);
    first.rememberAgentDisplayNames([{ id: 'acp-local-x', name: 'Yeni Ad' }]);

    const relaunched = await freshModule();
    expect(relaunched.agentDisplayName('acp-local-x')).toBe('Yeni Ad');
  });

  it('ignores corrupt or foreign stored entries', async () => {
    storage.setItem(STORAGE_KEY, '{not json');
    expect((await freshModule()).agentDisplayName('acp-local-x')).toBeUndefined();

    storage.setItem(STORAGE_KEY, JSON.stringify({ claude: 'Sahte', 'acp-local-y': 42 }));
    const module = await freshModule();
    expect(module.agentDisplayName('claude')).toBeUndefined();
    expect(module.agentDisplayName('acp-local-y')).toBeUndefined();
  });

  it('works without storage', async () => {
    vi.stubGlobal('localStorage', undefined);
    const module = await freshModule();
    module.rememberAgentDisplayNames([{ id: 'acp-local-z', name: 'Zed' }]);
    expect(module.agentDisplayName('acp-local-z')).toBe('Zed');
  });
});
