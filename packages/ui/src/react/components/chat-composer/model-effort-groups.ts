import type { ComposerEffortOption, ComposerModelOption } from './index';

export interface ModelListItem extends ComposerModelOption {
  id: string;
}

export interface EffortListItem extends ComposerEffortOption {
  id: string;
}

export interface EffortChoice {
  /** For embedded variants this is the full model id; for separate efforts this is the effort id. */
  value: string;
  label: string;
  rank: number;
  description?: string;
}

export type GroupedModelEntry =
  | {
      kind: 'embedded-group';
      key: string;
      baseName: string;
      variants: EffortChoice[];
      defaultVariant: EffortChoice;
      activeVariant: EffortChoice | null;
      isSelected: boolean;
    }
  | {
      kind: 'model';
      key: string;
      id: string;
      name: string;
      description?: string;
      isSelected: boolean;
      /** Separate provider effort choices shown on hover when the provider exposes `effortOptions`. */
      efforts: EffortChoice[];
      activeEffort: EffortChoice | null;
      defaultEffort: EffortChoice | null;
    };

export interface ModelTriggerDisplay {
  label: string;
  effortLabel: string | null;
}

const EFFORT_NAME_SUFFIX =
  /\s*\((Düşük|Orta|Yüksek|Çok Yüksek|En Yüksek|Maksimum|Ultra|Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;
const EFFORT_ID_SUFFIX = /-(low|medium|high|xhigh|extra|max|ultra)$/i;

const EFFORT_RANK: Record<string, number> = {
  varsayılan: 0,
  default: 0,
  düşük: 1,
  low: 1,
  orta: 2,
  medium: 2,
  yüksek: 3,
  high: 3,
  'çok yüksek': 4,
  xhigh: 4,
  extra: 4,
  'extra high': 4,
  'en yüksek': 5,
  maksimum: 5,
  max: 5,
  ultra: 6,
};

const DEFAULT_EFFORT_LABELS: Record<string, string> = {
  default: 'Varsayılan',
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
  xhigh: 'Çok Yüksek',
  extra: 'Çok Yüksek',
  max: 'En Yüksek',
  ultra: 'Ultra',
};

function effortRank(labelOrId: string): number {
  const key = labelOrId.trim().toLocaleLowerCase('tr-TR');
  return EFFORT_RANK[key] ?? 50;
}

function parseEmbeddedEffort(item: ModelListItem): {
  baseName: string;
  effortLabel: string;
  rank: number;
} | null {
  const nameMatch = EFFORT_NAME_SUFFIX.exec(item.name);
  if (nameMatch) {
    const baseName = item.name.slice(0, nameMatch.index).trim();
    const effortLabel = nameMatch[1]!.trim();
    if (baseName) {
      return { baseName, effortLabel, rank: effortRank(effortLabel) };
    }
  }
  const idMatch = EFFORT_ID_SUFFIX.exec(item.id);
  if (idMatch) {
    const suffix = idMatch[1]!.toLowerCase();
    const effortLabel = DEFAULT_EFFORT_LABELS[suffix] ?? suffix;
    const baseName = item.name.replace(EFFORT_NAME_SUFFIX, '').trim();
    if (baseName && baseName !== item.name) {
      return { baseName, effortLabel, rank: effortRank(suffix) };
    }
  }
  return null;
}

function pickPreferredChoice(choices: EffortChoice[]): EffortChoice {
  // Orta -> Yüksek -> ilk seçenek sırasıyla doğal varsayılanı seç.
  return choices.find((c) => c.rank === 2) ?? choices.find((c) => c.rank === 3) ?? choices[0]!;
}

/**
 * Düz model listesini (ve varsa ayrı efor seçeneklerini) satır + hover alt menüsü yapısına gruplar.
 * Aynı temel modelin 2+ efor varyantı varsa tek model satırında toplanır; tek varyantlı veya
 * efor içermeyen modeller doğrudan seçilebilir satır olarak kalır.
 */
export function buildGroupedModelEntries(
  modelItems: ModelListItem[],
  effortItems: EffortListItem[],
  selectedModel: string | null | undefined,
  selectedEffort: string | null | undefined
): { entries: GroupedModelEntry[]; trigger: ModelTriggerDisplay | null } {
  // 1. Önce gömülü efor varyantlarını temel ada göre grupla.
  const embeddedMap = new Map<
    string,
    {
      baseName: string;
      firstIndex: number;
      items: Array<{ item: ModelListItem; effortLabel: string; rank: number }>;
    }
  >();

  modelItems.forEach((item, index) => {
    const parsed = parseEmbeddedEffort(item);
    if (!parsed) return;
    const key = parsed.baseName.toLocaleLowerCase('tr-TR');
    const existing = embeddedMap.get(key);
    if (existing) {
      existing.items.push({ item, effortLabel: parsed.effortLabel, rank: parsed.rank });
    } else {
      embeddedMap.set(key, {
        baseName: parsed.baseName,
        firstIndex: index,
        items: [{ item, effortLabel: parsed.effortLabel, rank: parsed.rank }],
      });
    }
  });

  // Ayrı efor seçeneklerini (Claude, Codex, Grok vb.) sıralı hazırlama.
  const separateEfforts: EffortChoice[] = effortItems.map((e, idx) => ({
    value: e.id,
    label: e.name,
    rank:
      effortRank(e.id) !== 50
        ? effortRank(e.id)
        : effortRank(e.name) !== 50
          ? effortRank(e.name)
          : 50 + idx,
    description: e.description,
  }));
  const sortedSeparateEfforts =
    separateEfforts.length > 1 && separateEfforts.every((e) => e.rank < 50)
      ? [...separateEfforts].sort((a, b) => a.rank - b.rank)
      : separateEfforts;
  const activeSeparateEffort = selectedEffort
    ? (sortedSeparateEfforts.find((e) => e.value === selectedEffort) ?? null)
    : null;
  const defaultSeparateEffort =
    activeSeparateEffort ??
    (sortedSeparateEfforts.length > 0 ? pickPreferredChoice(sortedSeparateEfforts) : null);

  const entries: GroupedModelEntry[] = [];
  const emittedGroups = new Set<string>();
  let trigger: ModelTriggerDisplay | null = null;

  for (const item of modelItems) {
    const parsed = parseEmbeddedEffort(item);
    const groupKey = parsed ? parsed.baseName.toLocaleLowerCase('tr-TR') : null;
    const group = groupKey ? embeddedMap.get(groupKey) : undefined;

    if (group && group.items.length >= 2) {
      if (emittedGroups.has(groupKey!)) continue;
      emittedGroups.add(groupKey!);

      const variants: EffortChoice[] = [...group.items]
        .sort((a, b) => a.rank - b.rank)
        .map(({ item: variantItem, effortLabel, rank }) => ({
          value: variantItem.id,
          label: effortLabel,
          rank,
          description: variantItem.description,
        }));
      const activeVariant = selectedModel
        ? (variants.find((v) => v.value === selectedModel) ?? null)
        : null;
      const defaultVariant = activeVariant ?? pickPreferredChoice(variants);

      entries.push({
        kind: 'embedded-group',
        key: `group:${groupKey}`,
        baseName: group.baseName,
        variants,
        defaultVariant,
        activeVariant,
        isSelected: activeVariant !== null,
      });

      if (activeVariant) {
        trigger = { label: group.baseName, effortLabel: activeVariant.label };
      }
      continue;
    }

    const isSelected = selectedModel === item.id;
    entries.push({
      kind: 'model',
      key: item.id,
      id: item.id,
      name: item.name,
      description: item.description,
      isSelected,
      efforts: sortedSeparateEfforts,
      activeEffort: isSelected ? activeSeparateEffort : null,
      defaultEffort: defaultSeparateEffort,
    });

    if (isSelected) {
      trigger = {
        label: item.name,
        effortLabel: activeSeparateEffort?.label ?? null,
      };
    }
  }

  return { entries, trigger };
}
