import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import { settingsPageContributions } from '@core/manifests/browser/settings-page-contributions';
import { detectPlatformContext } from '@core/primitives/keybindings/api';

export type SettingsSearchEntry = {
  /** Stable kebab-case id; for SettingRow-backed settings it equals slugifySettingLabel(label). */
  id: string;
  /** The visible label of the setting in the UI. */
  label: string;
  tab: Exclude<SettingsPageTab, 'docs'>;
  description?: string;
  /** Extra terms (synonyms, provider names) that should also match this entry. */
  keywords?: string[];
};

/** Derives a stable search-entry id from a visible label. */
export function slugifySettingLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const trayIconLabel =
  detectPlatformContext().os === 'mac'
    ? 'Show Orkestra in the menu bar'
    : 'Show Orkestra in the system tray';

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // General
  {
    id: 'auto-generate-task-names',
    label: 'Auto-generate task names',
    tab: 'general',
    description: 'Automatically suggests a task name when creating a new task.',
  },
  {
    id: 'auto-approve-by-default',
    label: 'Auto-approve by default',
    tab: 'general',
    description: 'Skip permission prompts for supported agents when creating new tasks.',
    keywords: ['permissions', 'yolo'],
  },
  {
    id: 'auto-trust-worktree-directories',
    label: 'Auto-trust worktree directories',
    tab: 'general',
    description: 'Skip the folder trust prompt in supported CLIs for new tasks.',
    keywords: ['trust', 'claude code', 'copilot'],
  },
  {
    id: 'create-branch-and-worktree-by-default',
    label: 'Create branch and worktree by default',
    tab: 'general',
    description: 'Start new From Branch tasks in a dedicated task branch and worktree.',
    keywords: ['git'],
  },
  {
    id: 'preserve-task-name-capitalization',
    label: 'Preserve task name capitalization',
    tab: 'general',
    description: 'Keep uppercase letters in generated and manually entered task names.',
    keywords: ['lowercase', 'uppercase'],
  },
  {
    id: 'include-issue-context-by-default',
    label: 'Include issue context by default',
    tab: 'general',
    description: 'Add the selected issue to the initial agent prompt.',
  },
  {
    id: 'enable-tmux',
    label: 'Enable tmux',
    tab: 'general',
    description: 'Run agent sessions and terminals in tmux sessions by default.',
    keywords: ['multiplexer'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    tab: 'general',
    description: 'Get notified when agents need your attention.',
    keywords: ['alerts'],
  },
  {
    id: 'sound',
    label: 'Sound',
    tab: 'general',
    description: 'Play audio cues for agent events.',
    keywords: ['audio', 'notifications'],
  },
  {
    id: 'custom-sound',
    label: 'Custom sound',
    tab: 'general',
    description: 'Use an audio file instead of the built-in cue.',
    keywords: ['audio', 'notifications'],
  },
  {
    id: 'sound-timing',
    label: 'Sound timing',
    tab: 'general',
    description: 'When to play sounds.',
    keywords: ['audio', 'notifications', 'unfocused'],
  },
  {
    id: 'os-notifications',
    label: 'OS notifications',
    tab: 'general',
    description: 'Show system banners when agents need attention or finish.',
    keywords: ['banner', 'system'],
  },
  {
    id: 'hafif-yardimci-model-api',
    label: 'Text Generator API',
    tab: 'general',
    description: 'Otomatik başlık, prompt önerileri, inceleme turu ve yan sohbet için yardımcı model API ayarları.',
    keywords: ['text generator', 'openai', 'anthropic', 'api key', 'title', 'suggestions', 'öneri'],
  },
  {
    id: 'global-pencere-yakalama-kisayolu',
    label: 'Global SnapShot (macOS)',
    tab: 'general',
    description: 'Global kısayolla aktif pencereyi yakalayıp aktif sohbet kutusuna gönderir.',
    keywords: ['snapshot', 'ekran görüntüsü', 'screenshot', 'shortcut', 'kısayol'],
  },
  {
    id: 'ajan-calisirken-yeni-mesaj-gonderme',
    label: 'Sohbet Davranışı (Sıra / İptal Et & Bağlam Uyarısı)',
    tab: 'general',
    description: 'Ajan çalışırken yeni mesaj gönderme modu (sıraya al veya turu kes) ve bağlam sıkıştırma uyarısı.',
    keywords: ['queue', 'steer', 'cancel', 'compact', 'cache', 'yan sohbet', 'sohbet'],
  },

  // Agents
  {
    id: 'agents',
    label: 'Agents',
    tab: 'clis-models',
    description: 'Manage installed CLI agents and their configuration.',
    keywords: ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'antigravity', 'cli'],
  },
  {
    id: 'antigravity-orchestrator',
    label: 'Antigravity Orkestratör Modu',
    tab: 'clis-models',
    description: 'Antigravity Planlayıcı (Planner) ve Uygulayıcı (Executor) model ve düşünme düzeyi ayarları.',
    keywords: [
      'antigravity',
      'orchestrator',
      'orkestra',
      'orkestratör',
      'planner',
      'executor',
      'planlayıcı',
      'uygulayıcı',
      'neon',
      'carbon',
      'argon',
    ],
  },
  {
    id: 'yapilandirma-profilleri',
    label: 'Ajan Yapılandırma Profilleri',
    tab: 'clis-models',
    description: 'Her ajan için birden çok argüman ve ortam değişkeni profili oluşturup geçiş yapın.',
    keywords: ['profile', 'profil', 'env', 'extraArgs', 'agent profile'],
  },
  {
    id: 'mcp',
    label: 'MCP',
    tab: 'mcp',
    description: 'Manage local MCP servers available to agents.',
    keywords: ['model context protocol', 'servers', 'tools'],
  },
  {
    id: 'skills',
    label: 'Skills',
    tab: 'skills',
    description: 'Manage reusable local agent skills.',
    keywords: ['skill modules', 'agents'],
  },

  // Integrations
  {
    id: 'integrations',
    label: 'Integrations',
    tab: 'integrations',
    description: 'Connect issue trackers and source control providers.',
    keywords: ['github', 'gitlab', 'linear', 'jira', 'issues', 'connect'],
  },
  {
    id: '1password-op-referans-cozucu',
    label: '1Password op:// referans çözücü & Sır Maskeleme',
    tab: 'integrations',
    description: '1Password CLI ile op:// ortam değişkenlerini çözün ve sohbet kopyalamada gizli anahtarları maskeleyin.',
    keywords: ['1password', 'op', 'secrets', 'gizli', 'redaction', 'maskele'],
  },

  // Connections
  {
    id: 'ssh-connections',
    label: 'Machines',
    tab: 'connections',
    description: 'Reusable remote hosts for SSH projects.',
    keywords: ['remote', 'host'],
  },

  // Ses (sesle yazma ve sesli yanıtlar)
  {
    id: 'elevenlabs-api-key',
    label: 'ElevenLabs API anahtarı',
    tab: 'voice',
    description: 'Sesle yazma ve sesli yanıtlar için şifreli saklanan anahtar.',
    keywords: ['voice', 'ses', 'dikte', 'dictation', 'speech'],
  },
  {
    id: 'speech-language',
    label: 'Konuşma dili',
    tab: 'voice',
    description: 'Dikte edilen konuşmanın dili ya da otomatik algılama.',
    keywords: ['microphone', 'mikrofon', 'transcription'],
  },
  {
    id: 'reply-voice',
    label: 'Sesli yanıt sesi',
    tab: 'voice',
    description: 'Asistan yanıtlarını okuyan ElevenLabs sesi ve modeli.',
    keywords: ['tts', 'text to speech', 'hoparlör'],
  },
  {
    id: 'dolgu-kelimelerini-temizle',
    label: 'Dolgu kelimelerini temizle & Mikrofon sırası',
    tab: 'voice',
    description: 'Sesle yazmada konuşma dolgularını temizler ve mikrofon öncelik sırasını seçer.',
    keywords: ['filler', 'dolgu', 'mikrofon', 'microphone', 'priority', 'sıra'],
  },
  {
    id: 'yerel-dikte-mlx-whisper-groq',
    label: 'Yerel dikte (MLX Whisper), Groq / OpenAI STT & Otomatik gönder',
    tab: 'voice',
    description:
      'Çevrimdışı ücretsiz yerel Whisper, Groq / OpenAI uyumlu dikte sunucusu ve dikte bitince otomatik gönder ayarları.',
    keywords: [
      'yerel',
      'local',
      'mlx',
      'whisper',
      'faster-whisper',
      'groq',
      'openai',
      'dikte',
      'stt',
      'otomatik gönder',
      'auto send',
    ],
  },
  {
    id: 'chrome-bridge',
    label: 'Chrome köprüsü',
    tab: 'chrome',
    description: 'Ajanların Chrome uzantısı üzerinden tarayıcınızı kullanması; varsayılan kapalı.',
    keywords: ['chrome', 'uzantı', 'extension', 'tarayıcı', 'browser', 'eşleştirme', 'belirteç'],
  },

  // Repository
  {
    id: 'branch-prefix',
    label: 'Branch prefix',
    tab: 'repository',
    description: 'Leave empty to create branches without a prefix.',
    keywords: ['git'],
  },
  {
    id: 'random-branch-suffix',
    label: 'Random branch suffix',
    tab: 'repository',
    description: 'Add a random suffix to branch names.',
    keywords: ['git'],
  },
  {
    id: 'auto-push-on-create',
    label: 'Auto-push on create',
    tab: 'repository',
    description: 'Push the new branch to the selected project remote and set upstream.',
    keywords: ['git', 'remote', 'upstream'],
  },
  {
    id: 'dal-adlandirma-modu',
    label: 'Dal adlandırma modu & PR otomatik arşivleme',
    tab: 'repository',
    description: 'Worktree dal ön eki modu (sabit/anlamsal/özel) ve birleşen PR görevlerini otomatik arşivleme.',
    keywords: ['branch', 'semantic', 'feat', 'fix', 'merge', 'archive', 'arsiv', 'pr'],
  },
  // Local workspaces
  {
    id: 'task-worktree-storage',
    label: 'Workspaces',
    tab: 'workspaces-local',
    description: 'Review task worktree usage and remove stale task worktrees.',
    keywords: ['disk', 'cleanup', 'storage', 'worktrees'],
  },

  // Conversations
  {
    id: 'conversations',
    label: 'Conversations',
    tab: 'conversations',
    description: 'Every conversation record on this machine, including unlinked ones.',
    keywords: ['chats', 'sessions', 'orphaned', 'history', 'agents'],
  },

  // Prompts
  {
    id: 'prompts',
    label: 'Prompts',
    tab: 'prompts',
    description: 'Manage reusable prompts for tasks and conversations.',
    keywords: ['prompt library', 'snippets'],
  },

  // Log health
  {
    id: 'log-health',
    label: 'Günlük sağlığı',
    tab: 'log-health',
    description: 'Uygulama günlüğünde tekrarlayan uyarı ve hatalar.',
    keywords: ['log', 'logs', 'günlük', 'hata', 'uyarı', 'error', 'warning', 'diagnostics'],
  },

  // Eklentiler
  {
    id: 'plugins',
    label: 'Eklentiler',
    tab: 'plugins',
    description: 'Eklenti paketleri ve marketplace: skill, komut ve MCP sunucusu kurulumu.',
    keywords: ['eklenti', 'eklentiler', 'plugin', 'plugins', 'marketplace', 'paket', 'kur'],
  },

  // Lifecycle hooks
  {
    id: 'lifecycle-hooks',
    label: 'Kancalar',
    tab: 'lifecycle-hooks',
    description: 'Ajan ve görev olaylarında kendi komutlarınızı çalıştırın.',
    keywords: ['kanca', 'kancalar', 'hook', 'hooks', 'olay', 'komut', 'script', 'otomasyon'],
  },

  // Mobil erişim
  {
    id: 'remote-access',
    label: 'Mobil erişim',
    tab: 'remote-access',
    description: 'Telefondan QR ile bağlanma, eşleşmiş cihazlar.',
    keywords: ['mobil', 'telefon', 'android', 'qr', 'tailscale', 'uzak', 'eşleştir', 'remote'],
  },

  // System
  {
    id: 'system',
    label: 'System',
    tab: 'system',
    description: 'Review local resource utilization and system dependencies.',
    keywords: ['cpu', 'memory', 'disk', 'dependencies', 'git', 'tmux'],
  },

  // Interface
  {
    id: slugifySettingLabel(trayIconLabel),
    label: trayIconLabel,
    tab: 'interface',
    description: 'Keep quick access to Orkestra while agents run in the background.',
    keywords: ['menu bar', 'system tray', 'task bar', 'icon', 'hide', 'disable'],
  },
  {
    id: 'color-mode',
    label: 'Color mode',
    tab: 'interface',
    description: 'Choose how Orkestra looks.',
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'system'],
  },
  {
    id: 'vurgu-rengi-yazi-olcegi',
    label: 'Vurgu rengi & Yazı ölçeği',
    tab: 'interface',
    description: 'Arayüz vurgu rengini (6 preset) ve yazı boyutu ölçeğini özelleştirin.',
    keywords: ['accent', 'vurgu', 'color', 'font scale', 'yazı', 'boyut', 'theme'],
  },
  {
    id: 'default-terminal-shell',
    label: 'Default terminal shell',
    tab: 'interface',
    description: 'Used for new local terminals.',
    keywords: ['bash', 'zsh', 'fish'],
  },
  {
    id: 'terminal-font',
    label: 'Terminal font',
    tab: 'interface',
    description: 'Choose the font family for the terminal.',
    keywords: ['font family', 'menlo'],
  },
  {
    id: 'terminal-font-size',
    label: 'Terminal font size',
    tab: 'interface',
    description: 'Adjust the font size used by terminal sessions and CLI agents.',
    keywords: ['text size', 'zoom'],
  },
  {
    id: 'auto-copy-selected-text',
    label: 'Auto-copy selected text',
    tab: 'interface',
    description: 'Automatically copy text to clipboard when you select it in the terminal.',
    keywords: ['clipboard', 'terminal'],
  },
  {
    id: 'use-option-as-meta-key',
    label: 'Use Option as Meta key',
    tab: 'interface',
    description: 'Treat the Option key as the Meta key in the terminal.',
    keywords: ['macos', 'alt', 'terminal'],
  },
  {
    id: 'left-sidebar-line-changes',
    label: 'Left sidebar line changes',
    tab: 'interface',
    description: 'Show added and removed line counts for tasks in the left sidebar.',
    keywords: ['diff'],
  },
  {
    id: 'left-sidebar-pr-status',
    label: 'Left sidebar PR status',
    tab: 'interface',
    description: 'Show GitHub PR merge and status icons for tasks in the left sidebar.',
    keywords: ['pull request'],
  },
  {
    id: 'left-sidebar-timestamps',
    label: 'Left sidebar timestamps',
    tab: 'interface',
    description: 'Show the relative task timestamp in the left sidebar.',
    keywords: ['time'],
  },
  {
    id: 'resource-monitor',
    label: 'Resource monitor',
    tab: 'interface',
    description: 'Track CPU and memory usage for running agents.',
    keywords: ['cpu', 'memory', 'performance'],
  },
  {
    id: 'context-bar',
    label: 'Context bar',
    tab: 'interface',
    description: 'Hide the on-screen context trigger.',
  },
  {
    id: 'keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    tab: 'interface',
    description: 'Rebind, reset, or remove app keyboard shortcuts.',
    keywords: ['hotkeys', 'keybindings', 'rebind'],
  },
  {
    id: 'open-in-tools',
    label: 'Tools',
    tab: 'interface',
    description: 'Show or hide detected "Open in" apps in menus.',
    keywords: ['open in', 'editor', 'hidden tools'],
  },
  // Browser
  {
    id: 'default-browser-profile',
    label: 'Default browser profile',
    tab: 'browser',
    description: 'New browser tabs open with this profile.',
    keywords: ['isolated'],
  },
  {
    id: 'disable-cors-for-localhost',
    label: 'Disable CORS for localhost',
    tab: 'browser',
    description:
      'Allow localhost pages in Orkestra browser tabs to call APIs without CORS headers.',
    keywords: ['cross-origin'],
  },
  {
    id: 'browser-profiles',
    label: 'Browser profiles',
    tab: 'browser',
    description: 'Each profile keeps its own cookies and logins, shared across tasks.',
    keywords: ['cookies', 'logins'],
  },
  {
    id: 'browsing-data',
    label: 'Browsing data',
    tab: 'browser',
    description: 'Clear cookies, cached files, and site data from the in-app browser.',
    keywords: ['cookies', 'cache', 'clear', 'site data'],
  },
];

function normalizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function entryMatchesTokens(entry: SettingsSearchEntry, tokens: string[]): boolean {
  const haystack = [entry.label, entry.description ?? '', ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** All index entries matching the query. An empty/whitespace query matches nothing. */
export function searchSettings(
  query: string,
  index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX
): SettingsSearchEntry[] {
  const tokens = normalizeQuery(query);
  if (tokens.length === 0) return [];
  return index.filter((entry) => entryMatchesTokens(entry, tokens));
}

/** Tabs containing at least one match, in sidebar order. */
export function matchedTabsForQuery(
  query: string,
  index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX
): SettingsPageTab[] {
  const matchedTabs = new Set(searchSettings(query, index).map((entry) => entry.tab));
  return settingsPageContributions
    .filter((page) => matchedTabs.has(page.id))
    .map((page) => page.id);
}
