/**
 * Orkestra'nın model seçim kataloğu. Şef, alt görevin zorluğuna göre her sağlayıcının doğru
 * modelini seçer: zor ve kritik işler amiral gemisi modellere, basit işler hızlı modellere gider.
 * Eski nesil modeller, aynı sağlayıcıda daha yenisi varken kullanılmaz; yasaklı modeller hiç
 * kullanılmaz. Hem renderer (karar verici varsayılanı) hem ana süreç (işçi doğrulaması) kullanır.
 */

export const ORCHESTRA_DIFFICULTIES = ['trivial', 'standard', 'hard', 'critical'] as const;
export type OrchestraDifficulty = (typeof ORCHESTRA_DIFFICULTIES)[number];

export const ORCHESTRA_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type OrchestraEffort = (typeof ORCHESTRA_EFFORTS)[number];

/** Sağlayıcı içindeki rol: amiral gemisi, dengeli, hızlı, eski nesil veya yasaklı. */
export type OrchestraModelRole = 'flagship' | 'balanced' | 'fast' | 'legacy' | 'excluded';

export type OrchestraModelProfile = {
  role: OrchestraModelRole;
  /** Modelin güvenle üstlenebileceği en yüksek zorluk. */
  maxDifficulty: OrchestraDifficulty;
  /** Aynı roldeki modeller arasında tercih sırası; küçük olan önce gelir. */
  rank: number;
  note: string;
  /** Kıt/pahalı model: yalnızca kritik işlerde önerilir. */
  reserved?: boolean;
};

export type OrchestraModelInput = {
  id: string;
  name: string;
  description?: string;
  intelligence?: number;
  speed?: number;
};

type CatalogEntry = OrchestraModelProfile;

const profile = (
  role: OrchestraModelRole,
  maxDifficulty: OrchestraDifficulty,
  rank: number,
  note: string,
  reserved = false
): CatalogEntry => ({ role, maxDifficulty, rank, note, ...(reserved ? { reserved } : {}) });

/**
 * Ürün kuralı: GPT Astra ailesi (GPT-6 Astra ve sonraki tüm Astra sürümleri) işçi (alt) modeli
 * olarak hiçbir zaman kullanılmaz. Codex işlerinde zorluğa göre GPT-6.1 Sol, GPT-6 Pro veya
 * GPT-6 Luna seçilir. Claude Fable ailesi kıt olduğu için yalnızca kritik işlere ayrılır.
 */
const EXCLUDED_NOTE = 'Never used as a worker model in Orkestra (product rule).';
const RESERVED_NOTE = 'Scarce and expensive: reserved for critical work.';

/**
 * Ürün kuralları tek tek kimliklere değil model ailesine uygulanır; katalogda olmayan yeni
 * sürümler de (ör. GPT-6.1 Astra, Claude Fable 5.2) aynı kurala tabidir. Ailenin adı kimlikte
 * ya da görünen adda ayrı bir sözcük olarak geçmelidir ("astral" eşleşmez).
 */
const EXCLUDED_FAMILY = /(?:^|[^a-z])astra(?:[^a-z]|$)/i;
const RESERVED_FAMILY = /(?:^|[^a-z])fable(?:[^a-z]|$)/i;

function inFamily(model: OrchestraModelInput, family: RegExp): boolean {
  return family.test(model.id) || family.test(model.name);
}

const CATALOG: Record<string, Record<string, CatalogEntry>> = {
  claude: {
    'claude-fable-5-1': profile(
      'flagship',
      'critical',
      1,
      'Anthropic top model: deepest reasoning, architecture, subtle or high-risk changes, final review. Scarce and expensive: reserve for critical work.',
      true
    ),
    'claude-opus-5-5': profile(
      'flagship',
      'critical',
      2,
      'Very strong reasoning, large refactors and careful multi-file work; slower than Sonnet.'
    ),
    'claude-sonnet-5-5': profile(
      'balanced',
      'hard',
      1,
      'Fast and strong everyday coding and analysis; the efficient Claude choice for standard work.'
    ),
    'claude-haiku-4-5': profile(
      'fast',
      'trivial',
      1,
      'Fast and cheap: mechanical edits, simple lookups.'
    ),
    'claude-fable-5': profile('legacy', 'critical', 9, 'Superseded by Claude Fable 5.1.'),
    'claude-opus-5': profile('legacy', 'critical', 9, 'Superseded by Claude Opus 5.5.'),
    'claude-opus-4-8': profile('legacy', 'critical', 9, 'Older generation; use Opus 5.5.'),
    'claude-sonnet-5': profile('legacy', 'hard', 9, 'Superseded by Claude Sonnet 5.5.'),
  },
  codex: {
    'gpt-6.1-sol': profile(
      'flagship',
      'critical',
      1,
      'Newest GPT flagship and the best Codex workhorse: top intelligence and fast. Default for standard, hard and critical coding; several Sol workers can run in parallel.'
    ),
    'gpt-6-pro': profile(
      'flagship',
      'critical',
      2,
      'Highest-capability GPT tier for the hardest reasoning and algorithms; slowest, use only when Sol is not enough.'
    ),
    'gpt-6-luna': profile(
      'fast',
      'standard',
      1,
      'Fast, cost-efficient GPT-6 for lighter, well-specified tasks.'
    ),
    'gpt-6-astra': profile('excluded', 'critical', 99, EXCLUDED_NOTE),
    'gpt-6-sol': profile('legacy', 'critical', 9, 'Superseded by GPT-6.1 Sol.'),
    'gpt-5.6-sol': profile('legacy', 'critical', 9, 'Older generation; use GPT-6.1 Sol.'),
    'gpt-5.6-terra': profile('legacy', 'hard', 9, 'Older generation; use GPT-6.1 Sol or Luna.'),
    'gpt-5.6-luna': profile('legacy', 'standard', 9, 'Older generation; use GPT-6 Luna.'),
    'gpt-5.5': profile('legacy', 'hard', 9, 'Older generation; use GPT-6.1 Sol.'),
    'gpt-5.4-mini': profile('legacy', 'trivial', 9, 'Older generation; use GPT-6 Luna.'),
    'gpt-5.3-codex-spark': profile('legacy', 'trivial', 9, 'Low-intelligence preview model.'),
  },
  antigravity: {
    'gemini-3.1-pro-high': profile(
      'flagship',
      'critical',
      1,
      "Gemini's strongest reasoning with a very long context: large-codebase analysis and hard problems."
    ),
    'claude-opus-5-5-high': profile(
      'flagship',
      'critical',
      3,
      'Claude Opus 5.5 hosted by Antigravity (high thinking); prefer the Claude agent unless its quota is the constraint.'
    ),
    'claude-opus-5-5-medium': profile('flagship', 'hard', 4, 'Hosted Opus 5.5, medium thinking.'),
    'gemini-3.8-flash-high': profile(
      'balanced',
      'standard',
      1,
      'Newest Gemini Flash at high thinking: fast, capable, huge context; great for exploration, UI and broad reads.'
    ),
    'gemini-3.1-pro-low': profile('balanced', 'hard', 2, 'Gemini Pro with light thinking.'),
    'claude-sonnet-5-5-high': profile('balanced', 'hard', 3, 'Hosted Sonnet 5.5, high thinking.'),
    'claude-opus-5-5-low': profile('balanced', 'hard', 4, 'Hosted Opus 5.5, low thinking.'),
    'claude-sonnet-5-5-medium': profile('balanced', 'standard', 5, 'Hosted Sonnet 5.5.'),
    'gemini-3.8-flash-medium': profile(
      'fast',
      'trivial',
      1,
      'Very fast Gemini Flash for mechanical work.'
    ),
    'gemini-3.8-flash-low': profile('fast', 'trivial', 2, 'Fastest, lightest Gemini Flash.'),
    'claude-sonnet-5-5-low': profile('fast', 'standard', 3, 'Hosted Sonnet 5.5, low thinking.'),
    'gpt-oss-120b-medium': profile('fast', 'trivial', 4, 'Open-weight model for simple tasks.'),
    'gemini-3.7-flash-high': profile('legacy', 'standard', 9, 'Superseded by Gemini 3.8 Flash.'),
    'gemini-3.7-flash-medium': profile('legacy', 'trivial', 9, 'Superseded by Gemini 3.8 Flash.'),
    'gemini-3.7-flash-low': profile('legacy', 'trivial', 9, 'Superseded by Gemini 3.8 Flash.'),
    'gemini-3.6-flash-high': profile('legacy', 'standard', 9, 'Superseded by Gemini 3.8 Flash.'),
    'gemini-3.6-flash-medium': profile('legacy', 'trivial', 9, 'Superseded by Gemini 3.8 Flash.'),
    'gemini-3.6-flash-low': profile('legacy', 'trivial', 9, 'Superseded by Gemini 3.8 Flash.'),
    'claude-sonnet-4-6': profile('legacy', 'hard', 9, 'Older Claude generation.'),
    'claude-opus-4-6-thinking': profile('legacy', 'critical', 9, 'Older Claude generation.'),
  },
  kimi: {
    'kimi-code/k3': profile(
      'flagship',
      'hard',
      1,
      "Kimi's newest flagship: strong agentic coding over many files, cost-efficient."
    ),
    'kimi-code/k3-256k': profile(
      'flagship',
      'hard',
      2,
      'K3 with a 256k context window for very large inputs.'
    ),
    'kimi-code/kimi-for-coding': profile(
      'balanced',
      'standard',
      1,
      'K2.8 preview for everyday coding.'
    ),
    'kimi-code/kimi-for-coding-highspeed': profile(
      'fast',
      'trivial',
      1,
      'K2.7 high-speed model for quick mechanical work.'
    ),
  },
  grok: {
    'grok-4.7': profile(
      'flagship',
      'hard',
      1,
      'Newest Grok flagship: fast reasoning, prototypes, alternative approaches.'
    ),
    'grok-4.7-build-fast': profile(
      'fast',
      'standard',
      1,
      'Fast Grok for quick scripts and small fixes.'
    ),
    'grok-4.6': profile('legacy', 'hard', 9, 'Superseded by Grok 4.7.'),
    'grok-4.5': profile('legacy', 'hard', 9, 'Superseded by Grok 4.7.'),
  },
  glm: {
    'glm-5.3': profile(
      'balanced',
      'standard',
      1,
      'GLM flagship on Z.ai: low-cost, solid general coding and boilerplate.'
    ),
    'glm-5.3-flash': profile('fast', 'trivial', 1, 'Fast GLM for mechanical edits.'),
  },
};

const DIFFICULTY_RANK: Record<OrchestraDifficulty, number> = {
  trivial: 0,
  standard: 1,
  hard: 2,
  critical: 3,
};

export function difficultyRank(difficulty: OrchestraDifficulty): number {
  return DIFFICULTY_RANK[difficulty];
}

export function isOrchestraDifficulty(value: unknown): value is OrchestraDifficulty {
  return typeof value === 'string' && value in DIFFICULTY_RANK;
}

export function isOrchestraEffort(value: unknown): value is OrchestraEffort {
  return typeof value === 'string' && (ORCHESTRA_EFFORTS as readonly string[]).includes(value);
}

/** Katalogda olmayan modeller için sağlayıcının bildirdiği puanlardan tahmini profil. */
function inferProfile(model: OrchestraModelInput): OrchestraModelProfile {
  const label = `${model.id} ${model.name}`.toLowerCase();
  if (/\b(mini|spark|lite|nano)\b|flash-low|\(düşük\)/.test(label)) {
    return profile('fast', 'trivial', 5, 'Lightweight model (inferred).');
  }
  const intelligence = model.intelligence;
  if (intelligence === undefined) {
    return profile('balanced', 'hard', 5, 'No capability data; treated as a balanced model.');
  }
  if (intelligence >= 5) return profile('flagship', 'critical', 5, 'Top-tier model (inferred).');
  if (intelligence >= 4) return profile('balanced', 'standard', 5, 'Capable model (inferred).');
  return profile('fast', 'trivial', 5, 'Lightweight model (inferred).');
}

export function orchestraModelProfile(
  providerId: string,
  model: OrchestraModelInput
): OrchestraModelProfile {
  const base = CATALOG[providerId]?.[model.id] ?? inferProfile(model);
  if (inFamily(model, EXCLUDED_FAMILY)) {
    return profile('excluded', base.maxDifficulty, 99, EXCLUDED_NOTE);
  }
  if (inFamily(model, RESERVED_FAMILY) && !base.reserved) {
    return { ...base, reserved: true, note: `${base.note} ${RESERVED_NOTE}` };
  }
  return base;
}

/** Kıt modeller (Claude Fable ailesi) yalnızca kritik işlerde işçi olarak kullanılabilir. */
export function isReservedForDifficulty(
  modelProfile: OrchestraModelProfile,
  difficulty: OrchestraDifficulty
): boolean {
  return modelProfile.reserved === true && difficulty !== 'critical';
}

export type RankedOrchestraModel = OrchestraModelInput & { profile: OrchestraModelProfile };

/**
 * İşçilerin kullanabileceği modeller, tercih sırasına göre. Yasaklı modeller hiç dönmez; eski
 * nesil modeller yalnızca sağlayıcıda başka seçenek yoksa döner.
 */
export function usableOrchestraModels(
  providerId: string,
  models: readonly OrchestraModelInput[]
): RankedOrchestraModel[] {
  const ranked = models
    .map((model) => ({ ...model, profile: orchestraModelProfile(providerId, model) }))
    .filter((model) => model.profile.role !== 'excluded');
  const current = ranked.filter((model) => model.profile.role !== 'legacy');
  const pool = current.length > 0 ? current : ranked;
  const roleOrder: Record<OrchestraModelRole, number> = {
    flagship: 0,
    balanced: 1,
    fast: 2,
    legacy: 3,
    excluded: 4,
  };
  return pool.sort(
    (left, right) =>
      roleOrder[left.profile.role] - roleOrder[right.profile.role] ||
      left.profile.rank - right.profile.rank
  );
}

/**
 * Bu zorluktaki bir işte işçi olarak seçilebilecek modeller, tercih sırasına göre: işin
 * zorluğunu karşılamalı ve kıt modeller yalnızca kritik işlerde yer almalıdır.
 */
export function capableOrchestraModels(
  providerId: string,
  models: readonly OrchestraModelInput[],
  difficulty: OrchestraDifficulty
): RankedOrchestraModel[] {
  return usableOrchestraModels(providerId, models).filter(
    (model) =>
      difficultyRank(model.profile.maxDifficulty) >= difficultyRank(difficulty) &&
      !isReservedForDifficulty(model.profile, difficulty)
  );
}

/**
 * Zorluğa uygun en iyi model: kritik/zor işlerde en güçlü model, standart işlerde dengeli,
 * basit işlerde hızlı model öne alınır; hepsi işin zorluğunu karşılayabilmelidir.
 */
export function recommendOrchestraModel(
  providerId: string,
  models: readonly OrchestraModelInput[],
  difficulty: OrchestraDifficulty
): RankedOrchestraModel | null {
  const capable = capableOrchestraModels(providerId, models, difficulty);
  if (capable.length === 0) return null;
  const preferredRoles: Record<OrchestraDifficulty, OrchestraModelRole[]> = {
    critical: ['flagship', 'balanced', 'fast', 'legacy'],
    hard: ['flagship', 'balanced', 'fast', 'legacy'],
    standard: ['balanced', 'flagship', 'fast', 'legacy'],
    trivial: ['fast', 'balanced', 'flagship', 'legacy'],
  };
  for (const role of preferredRoles[difficulty]) {
    const match = capable.find((model) => model.profile.role === role);
    if (match) return match;
  }
  return capable[0] ?? null;
}

export function effortForDifficulty(difficulty: OrchestraDifficulty): OrchestraEffort {
  switch (difficulty) {
    case 'critical':
      return 'max';
    case 'hard':
      return 'high';
    case 'standard':
      return 'medium';
    case 'trivial':
      return 'low';
  }
}

const EFFORT_TOKENS: Record<OrchestraEffort, string[]> = {
  max: ['max', 'maximum', 'xhigh', 'x-high', 'extra high', 'extra-high', 'ultra', 'highest'],
  high: ['high', 'yüksek'],
  medium: ['medium', 'med', 'orta', 'default', 'balanced', 'normal'],
  low: ['low', 'düşük', 'minimal', 'minimum', 'min', 'light'],
};

const EFFORT_FALLBACK: Record<OrchestraEffort, OrchestraEffort[]> = {
  max: ['max', 'high', 'medium'],
  high: ['high', 'max', 'medium'],
  medium: ['medium', 'high', 'low'],
  low: ['low', 'medium'],
};

function normalizeEffortLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[_]+/g, ' ');
}

/**
 * Sağlayıcının düşünme seviyesi seçenekleri arasından istenen seviyeye en yakın olanı seçer.
 * Önce kimlik/ad tam eşleşmesi, sonra en yakın üst/alt seviye denenir.
 */
export function pickEffortOption(
  options: readonly { id: string; name: string }[],
  level: OrchestraEffort
): { id: string; name: string } | null {
  if (options.length === 0) return null;
  const matches = (option: { id: string; name: string }, wanted: OrchestraEffort) => {
    const id = normalizeEffortLabel(option.id);
    const name = normalizeEffortLabel(option.name);
    return EFFORT_TOKENS[wanted].some((token) => id === token || name === token);
  };
  for (const wanted of EFFORT_FALLBACK[level]) {
    const option = options.find((candidate) => matches(candidate, wanted));
    if (option) return option;
  }
  return null;
}
