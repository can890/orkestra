export type ReviewGuideCategory = 'contracts' | 'core' | 'ui' | 'tests' | 'config';

export type ReviewGuideRiskLevel = 'low' | 'medium' | 'high';

export interface ReviewGuideFileInput {
  diffRevision?: string;
  path: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface ReviewGuideStep {
  id: string;
  category: ReviewGuideCategory;
  title: string;
  summary: string;
  files: string[];
  riskLevel: ReviewGuideRiskLevel;
}

export interface ReviewGuide {
  source: 'heuristic' | 'llm';
  summary: string;
  steps: ReviewGuideStep[];
  totalFiles: number;
}

const CATEGORY_ORDER: readonly ReviewGuideCategory[] = [
  'contracts',
  'core',
  'ui',
  'tests',
  'config',
];

const CATEGORY_META: Record<
  ReviewGuideCategory,
  { title: string; summary: string; defaultRisk: ReviewGuideRiskLevel }
> = {
  contracts: {
    title: '1. Sözleşmeler, Tipler & Şemalar',
    summary: 'Veri modelleri, RPC sözleşmeleri ve ayar şemalarındaki değişimleri önce doğrulayın.',
    defaultRisk: 'high',
  },
  core: {
    title: '2. Çekirdek Servisler & İş Mantığı',
    summary:
      'Ana süreç servisleri, depolama/durum yöneticileri ve API entegrasyonlarını inceleyin.',
    defaultRisk: 'medium',
  },
  ui: {
    title: '3. Arayüz & React Bileşenleri',
    summary: 'Kullanıcı etkileşimleri, erişilebilirlik ve görsel geri bildirimleri kontrol edin.',
    defaultRisk: 'low',
  },
  tests: {
    title: '4. Otomatik Testler',
    summary:
      'Birim ve entegrasyon testlerinin yeni davranış ve sınır durumlarını kapsadığını doğrulayın.',
    defaultRisk: 'low',
  },
  config: {
    title: '5. Yapılandırma, Kaynaklar & Diğerleri',
    summary: 'Yapılandırma, paketleme veya statik dosyalardaki yan etkileri kontrol edin.',
    defaultRisk: 'low',
  },
};

export function classifyReviewFile(filePath: string): ReviewGuideCategory {
  const lower = filePath.toLowerCase();
  if (/(?:^|\/).*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return 'tests';
  }
  if (
    /(?:contract|schema|types?|app-settings|contribution|interface)/.test(lower) ||
    /\/api\/[^/]*\.ts$/.test(lower)
  ) {
    return 'contracts';
  }
  if (
    /(?:\/browser\/|\/renderer\/|\/components\/)/.test(lower) ||
    /\.(?:tsx|jsx|css|scss|html)$/.test(lower)
  ) {
    return 'ui';
  }
  if (
    /(?:\/node\/|\/main\/|\/services\/|\/stores\/|service|controller|store|resolver)/.test(lower) ||
    /\.(?:ts|mjs|cjs|js|py|go|rs)$/.test(lower)
  ) {
    return 'core';
  }
  return 'config';
}

export function buildHeuristicReviewGuide(files: readonly ReviewGuideFileInput[]): ReviewGuide {
  const grouped = new Map<ReviewGuideCategory, ReviewGuideFileInput[]>();
  const uniquePaths = new Set<string>();

  for (const file of files) {
    const cleanPath = file.path.trim();
    if (!cleanPath || uniquePaths.has(cleanPath)) continue;
    uniquePaths.add(cleanPath);
    const category = classifyReviewFile(cleanPath);
    const list = grouped.get(category) ?? [];
    list.push({ ...file, path: cleanPath });
    grouped.set(category, list);
  }

  const steps: ReviewGuideStep[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = grouped.get(category);
    if (!items || items.length === 0) continue;
    const meta = CATEGORY_META[category];
    const churn = items.reduce(
      (sum, item) => sum + (item.additions ?? 0) + (item.deletions ?? 0),
      0
    );
    const riskLevel: ReviewGuideRiskLevel =
      category === 'contracts' || churn > 300
        ? 'high'
        : category === 'core' || churn > 100
          ? 'medium'
          : meta.defaultRisk;

    steps.push({
      id: `step-${category}`,
      category,
      title: meta.title,
      summary: `${items.length} dosya · ${meta.summary}`,
      files: items.map((item) => item.path).sort((a, b) => a.localeCompare(b)),
      riskLevel,
    });
  }

  const totalFiles = uniquePaths.size;
  return {
    source: 'heuristic',
    summary:
      totalFiles === 0
        ? 'İncelenecek dosya değişikliği bulunamadı.'
        : `${totalFiles} değişen dosya ${steps.length} mantıksal inceleme adımına ayrıldı.`,
    steps,
    totalFiles,
  };
}

function normalizeCategory(raw: unknown): ReviewGuideCategory {
  if (
    raw === 'contracts' ||
    raw === 'core' ||
    raw === 'ui' ||
    raw === 'tests' ||
    raw === 'config'
  ) {
    return raw;
  }
  return 'core';
}

function normalizeRisk(raw: unknown): ReviewGuideRiskLevel {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

export function parseLlmReviewGuide(
  rawJson: string,
  fallbackFiles: readonly string[]
): ReviewGuide | null {
  const cleaned = rawJson
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { summary?: unknown; steps?: unknown };
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;

  const validFallback = new Set(fallbackFiles);
  const steps: ReviewGuideStep[] = [];
  const covered = new Set<string>();

  for (let i = 0; i < obj.steps.length; i += 1) {
    const rawStep = obj.steps[i];
    if (!rawStep || typeof rawStep !== 'object') continue;
    const item = rawStep as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    const rawFiles = Array.isArray(item.files)
      ? item.files
          .filter((f): f is string => typeof f === 'string')
          .map((f) => f.trim())
          .filter((f) => f.length > 0 && (validFallback.size === 0 || validFallback.has(f)))
      : [];
    if (!title || rawFiles.length === 0) continue;
    for (const f of rawFiles) covered.add(f);
    steps.push({
      id: `llm-step-${i + 1}`,
      category: normalizeCategory(item.category),
      title,
      summary: summary || `${rawFiles.length} dosya bu adımda gruplandı.`,
      files: rawFiles,
      riskLevel: normalizeRisk(item.riskLevel),
    });
  }

  if (steps.length === 0) return null;

  const remaining = fallbackFiles.filter((f) => !covered.has(f));
  if (remaining.length > 0) {
    steps.push({
      id: `llm-step-extra`,
      category: 'config',
      title: 'Diğer Değişiklikler',
      summary: `${remaining.length} ek dosya incelemeye eklendi.`,
      files: remaining,
      riskLevel: 'low',
    });
  }

  const totalFiles = new Set([...covered, ...fallbackFiles]).size;
  return {
    source: 'llm',
    summary:
      typeof obj.summary === 'string' && obj.summary.trim()
        ? obj.summary.trim()
        : `${totalFiles} dosya için yapay zekâ inceleme turu oluşturuldu.`,
    steps,
    totalFiles,
  };
}

export function isReviewFileViewed(
  revision: string,
  savedRevision: string | undefined,
  nativeViewed: boolean | undefined
): boolean {
  return nativeViewed === undefined
    ? savedRevision === revision
    : nativeViewed && (savedRevision === undefined || savedRevision === revision);
}
