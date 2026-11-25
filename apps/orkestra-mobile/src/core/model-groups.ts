/**
 * Mac Sovra uygulamasındaki gruplu Model + Efor seçicisinin mobil karşılığı.
 * "Gemini 4 Neon (Low/Medium/High/XHigh)" gibi varyantları tek model kartında toplar ve
 * efor çiplerini satır içinde gösterir.
 */
import type { ConfigOptionView } from './mappers';

export type EffortChoice = {
  value: string;
  label: string;
  rank: number;
};

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
      efforts: EffortChoice[];
      activeEffort: EffortChoice | null;
      defaultEffort: EffortChoice | null;
    };

const EFFORT_NAME_SUFFIX =
  /\s*\((Düşük|Orta|Yüksek|Çok Yüksek|En Yüksek|Maksimum|Maks|Ultra|Low|Medium|High|XHigh|Extra High|Extra|Max)\)\s*$/i;
const EFFORT_ID_SUFFIX = /-(low|medium|high|xhigh|extra|max|ultra)$/i;

const EFFORT_TR_LABELS: Record<string, string> = {
  default: 'Varsayılan',
  varsayılan: 'Varsayılan',
  low: 'Düşük',
  düşük: 'Düşük',
  medium: 'Orta',
  orta: 'Orta',
  high: 'Yüksek',
  yüksek: 'Yüksek',
  xhigh: 'Çok Yüksek',
  extra: 'Çok Yüksek',
  'extra high': 'Çok Yüksek',
  'çok yüksek': 'Çok Yüksek',
  max: 'Maks',
  maks: 'Maks',
  maksimum: 'Maks',
  'en yüksek': 'Maks',
  ultra: 'Ultra',
};

const EFFORT_RANK: Record<string, number> = {
  varsayılan: 0,
  düşük: 1,
  orta: 2,
  yüksek: 3,
  'çok yüksek': 4,
  maks: 5,
  ultra: 6,
};

function normalizeEffortLabel(raw: string): { label: string; rank: number } {
  const key = raw.trim().toLocaleLowerCase('tr-TR');
  const label = EFFORT_TR_LABELS[key] ?? raw.trim();
  const rank = EFFORT_RANK[label.toLocaleLowerCase('tr-TR')] ?? 50;
  return { label, rank };
}

function parseEmbeddedEffort(opt: ConfigOptionView): {
  baseName: string;
  label: string;
  rank: number;
} | null {
  const nameMatch = EFFORT_NAME_SUFFIX.exec(opt.name);
  if (nameMatch) {
    const baseName = opt.name.slice(0, nameMatch.index).trim();
    if (baseName) {
      const { label, rank } = normalizeEffortLabel(nameMatch[1]!);
      return { baseName, label, rank };
    }
  }
  const idMatch = EFFORT_ID_SUFFIX.exec(opt.id);
  if (idMatch) {
    const baseName = opt.name.replace(EFFORT_NAME_SUFFIX, '').trim();
    if (baseName && baseName !== opt.name) {
      const { label, rank } = normalizeEffortLabel(idMatch[1]!);
      return { baseName, label, rank };
    }
  }
  return null;
}

function pickDefaultChoice(choices: EffortChoice[]): EffortChoice {
  return choices.find((c) => c.rank === 2) ?? choices.find((c) => c.rank === 3) ?? choices[0]!;
}

export function groupMobileModelOptions(
  modelOptions: readonly ConfigOptionView[],
  selectedModelId: string | null,
  separateEfforts: readonly ConfigOptionView[],
  selectedEffortId: string | null
): GroupedModelEntry[] {
  const separateChoices: EffortChoice[] = separateEfforts
    .map((eff) => {
      const { label, rank } = normalizeEffortLabel(eff.name || eff.id);
      return { value: eff.id, label, rank };
    })
    .sort((a, b) => a.rank - b.rank);

  const embeddedBuckets = new Map<
    string,
    { baseName: string; items: Array<{ opt: ConfigOptionView; label: string; rank: number }> }
  >();
  const order: Array<{ kind: 'bucket'; key: string } | { kind: 'single'; opt: ConfigOptionView }> =
    [];

  for (const opt of modelOptions) {
    const parsed = parseEmbeddedEffort(opt);
    if (parsed) {
      const key = parsed.baseName.toLocaleLowerCase('tr-TR');
      let bucket = embeddedBuckets.get(key);
      if (!bucket) {
        bucket = { baseName: parsed.baseName, items: [] };
        embeddedBuckets.set(key, bucket);
        order.push({ kind: 'bucket', key });
      }
      bucket.items.push({ opt, label: parsed.label, rank: parsed.rank });
    } else {
      order.push({ kind: 'single', opt });
    }
  }

  const result: GroupedModelEntry[] = [];
  for (const slot of order) {
    if (slot.kind === 'bucket') {
      const bucket = embeddedBuckets.get(slot.key)!;
      if (bucket.items.length === 1) {
        const only = bucket.items[0]!.opt;
        const activeEffort = separateChoices.find((c) => c.value === selectedEffortId) ?? null;
        result.push({
          kind: 'model',
          key: only.id,
          id: only.id,
          name: only.name,
          description: only.description ?? undefined,
          isSelected: selectedModelId === only.id,
          efforts: separateChoices,
          activeEffort,
          defaultEffort: separateChoices.length > 0 ? pickDefaultChoice(separateChoices) : null,
        });
      } else {
        const variants: EffortChoice[] = bucket.items
          .map((item) => ({ value: item.opt.id, label: item.label, rank: item.rank }))
          .sort((a, b) => a.rank - b.rank);
        const activeVariant = variants.find((v) => v.value === selectedModelId) ?? null;
        result.push({
          kind: 'embedded-group',
          key: `group:${slot.key}`,
          baseName: bucket.baseName,
          variants,
          defaultVariant: pickDefaultChoice(variants),
          activeVariant,
          isSelected: activeVariant !== null,
        });
      }
    } else {
      const opt = slot.opt;
      const activeEffort = separateChoices.find((c) => c.value === selectedEffortId) ?? null;
      result.push({
        kind: 'model',
        key: opt.id,
        id: opt.id,
        name: opt.name,
        description: opt.description ?? undefined,
        isSelected: selectedModelId === opt.id,
        efforts: separateChoices,
        activeEffort,
        defaultEffort: separateChoices.length > 0 ? pickDefaultChoice(separateChoices) : null,
      });
    }
  }
  return result;
}
