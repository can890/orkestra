import type { FindingSeverity, ReviewFinding, ReviewReport, ReviewVerdict } from './review-model';

/**
 * İnceleyicinin yanıtındaki yapılandırılmış bulguları ayrıştırır. Biçim `buildReviewPrompt`
 * tarafından istenir; ama modeller küçük sapmalar yapar (markdown kalın yazı, liste imleri,
 * başlıklar, eş anlamlı alan adları, farklı konum yazımları). Ayrıştırıcı bunlara dayanıklıdır ve
 * hiçbir zaman hata fırlatmaz.
 */

type FieldKey = 'severity' | 'location' | 'summary' | 'failureScenario' | 'suggestedFix';

const FIELD_ALIASES: ReadonlyArray<readonly [RegExp, FieldKey]> = [
  [/^(?:severity|priority|önem(?: derecesi)?)$/u, 'severity'],
  [/^(?:location|file|path|where|konum|dosya)$/u, 'location'],
  [/^(?:summary|title|problem|issue|description|özet)$/u, 'summary'],
  [
    /^(?:failure scenario|failure|scenario|impact|failure mode|how it fails|why it matters|senaryo|hata senaryosu)$/u,
    'failureScenario',
  ],
  [
    /^(?:suggested fix|fix|suggestion|recommendation|recommended fix|proposed fix|remediation|öneri|önerilen düzeltme)$/u,
    'suggestedFix',
  ],
];

const SEVERITY_ALIASES: ReadonlyArray<readonly [RegExp, FindingSeverity]> = [
  [/\b(?:critical|blocker|blocking|severe|p0|kritik)\b/u, 'critical'],
  [/\b(?:high|major|important|p1|yüksek)\b/u, 'high'],
  [/\b(?:medium|moderate|normal|p2|orta)\b/u, 'medium'],
  [/\b(?:low|minor|nit|nitpick|trivial|info|informational|suggestion|p3|düşük)\b/u, 'low'],
];

const FINDING_HEADER_RE = /^(?:finding|issue|bulgu)\s*#?\s*(\d+)\b\s*[:.)\-–—]?\s*(.*)$/iu;
const FIELD_RE = /^([A-Za-zÇĞİÖŞÜçğıöşü][A-Za-zÇĞİÖŞÜçğıöşü ]{1,30}?)\s*[:：]\s*(.*)$/u;
const NO_FINDINGS_RE =
  /^(?:no (?:findings|issues|problems)(?: found| identified| to report)?|bulgu yok)\.?$/iu;
const VERDICT_RE = /^(?:final\s+)?(?:verdict|karar)\s*[:：\-–—]?\s*(.*)$/iu;
const RATIONALE_RE = /^(?:rationale|reason|reasoning|gerekçe)\s*[:：]\s*(.*)$/iu;

/** Satırı markdown süslerinden arındırır: başlık, alıntı, madde imleri, kalın/italik. */
function cleanLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(/^>+\s*/u, '');
  line = line.replace(/^#{1,6}\s*/u, '');
  line = line.replace(/^[-*+•]\s+(?=\S)/u, '');
  line = line.replace(/\*\*|__/gu, '');
  line = line.replace(/^\*(.+)\*$/u, '$1');
  return line.trim();
}

const NUMBERED_RE = /^(\d+)[.)]\s+(.*)$/u;

function fieldKeyFor(label: string): FieldKey | null {
  const normalized = label.trim().toLowerCase().replace(/\s+/gu, ' ');
  for (const [pattern, key] of FIELD_ALIASES) {
    if (pattern.test(normalized)) return key;
  }
  return null;
}

export function normalizeSeverity(raw: string | null | undefined): FindingSeverity | null {
  const value = raw?.toLowerCase() ?? '';
  for (const [pattern, severity] of SEVERITY_ALIASES) {
    if (pattern.test(value)) return severity;
  }
  return null;
}

export function normalizeVerdict(raw: string | null | undefined): ReviewVerdict | null {
  const value = (raw ?? '').toLowerCase().replace(/[`*_]/gu, '').trim();
  if (!value) return null;
  if (
    /request(?:ing)?[\s-]*changes|changes[\s-]*requested|\breject|\bblock|needs[\s-]*(?:work|changes)|do not merge|değişiklik iste/u.test(
      value
    )
  ) {
    return 'request-changes';
  }
  if (/\bcomment|with (?:nits|comments|suggestions)|non-blocking|yorum/u.test(value)) {
    return 'comment';
  }
  if (/\bapprove|\blgtm\b|looks good|ship it|\baccept|onay/u.test(value)) return 'approve';
  return null;
}

export type ParsedLocation = { file: string | null; line: number | null; endLine: number | null };

const LOCATION_LINE_RE =
  /([^\s`'"()<>[\]]+?)(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?(?::\d+)?(?![\w/])/u;
const LOCATION_WORD_RE =
  /([^\s`'"()<>[\],]+)\s*[,(]?\s*(?:lines?|satır)\s+(\d+)(?:\s*[-–]\s*(\d+))?/iu;

function cleanPath(path: string): string {
  return path
    .replace(/^[`'"[(]+|[`'"\]),.;:]+$/gu, '')
    .replace(/^\.\//u, '')
    .replace(/^[ab]\/(?=\S+\/)/u, '');
}

function positive(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** "src/a.ts:42", "`src/a.ts:42-50`", "src/a.ts#L42", "src/a.ts (line 42)" gibi yazımları çözer. */
export function parseLocation(raw: string | null | undefined): ParsedLocation {
  const text = (raw ?? '').replace(/[`*]/gu, ' ').trim();
  if (!text) return { file: null, line: null, endLine: null };
  const withLine = LOCATION_LINE_RE.exec(text) ?? LOCATION_WORD_RE.exec(text);
  if (withLine) {
    const line = positive(withLine[2]);
    const end = positive(withLine[3]);
    return {
      file: cleanPath(withLine[1]!) || null,
      line,
      endLine: end !== null && line !== null && end > line ? end : null,
    };
  }
  const token = text.split(/\s+/u)[0] ?? '';
  const looksLikePath = /[/\\]/u.test(token) || /\.[A-Za-z0-9]{1,10}$/u.test(token);
  return { file: looksLikePath ? cleanPath(token) || null : null, line: null, endLine: null };
}

type Draft = {
  /** Açık bir "FINDING n" başlığıyla başladı. */
  explicit: boolean;
  header: string;
  fields: Partial<Record<FieldKey, string>>;
  current: FieldKey | null;
};

function emptyDraft(explicit: boolean, header = ''): Draft {
  return { explicit, header, fields: {}, current: null };
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Başlık satırındaki satır içi bilgiyi ("[HIGH] src/a.ts:3 — özet") alanlara dağıtır. */
function headerFallbacks(header: string): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  let rest = header.trim();
  if (!rest) return result;
  const bracket = /^\[([^\]]+)\]\s*/u.exec(rest) ?? /^\(([^)]+)\)\s*/u.exec(rest);
  if (bracket && normalizeSeverity(bracket[1])) {
    result.severity = bracket[1];
    rest = rest.slice(bracket[0].length);
  }
  const location = LOCATION_LINE_RE.exec(rest);
  if (location && location.index === 0) {
    result.location = location[0];
    rest = rest.slice(location[0].length);
  }
  rest = rest.replace(/^\s*[-–—:|]\s*/u, '').trim();
  if (rest) result.summary = rest;
  return result;
}

function finalizeDraft(draft: Draft, index: number): ReviewFinding | null {
  const fallbacks = headerFallbacks(draft.header);
  const pick = (key: FieldKey) => {
    const value = (draft.fields[key] ?? fallbacks[key])?.trim();
    return value ? value : null;
  };
  const rawLocation = pick('location');
  const location = parseLocation(rawLocation);
  // Başlıksız bir blok, önem ya da konum taşımıyorsa düzyazıdır ("Summary: genel olarak iyi").
  if (!draft.explicit && !pick('severity') && !location.file) return null;
  const failureScenario = pick('failureScenario');
  const summary = pick('summary') ?? failureScenario?.split(/(?<=[.!?])\s/u)[0] ?? null;
  if (!summary && !location.file) return null;
  const finalSummary = summary ?? `${location.file}${location.line ? `:${location.line}` : ''}`;
  const severity = normalizeSeverity(pick('severity')) ?? 'medium';
  return {
    id: `f${index}-${hashString(`${location.file ?? ''}:${location.line ?? ''}:${finalSummary}`)}`,
    index,
    severity,
    file: location.file,
    line: location.line,
    endLine: location.endLine,
    location: rawLocation,
    summary: finalSummary,
    failureScenario,
    suggestedFix: pick('suggestedFix'),
  };
}

/** "1. [High] src/a.ts:3 — özet" biçimindeki numaralı başlık; köşeli parantezde önem olmalı. */
function numberedSeverityHeader(line: string): RegExpExecArray | null {
  const match = NUMBERED_RE.exec(line);
  if (!match) return null;
  const bracket = /^\[([^\]]+)\]/u.exec(match[2]!);
  return bracket && normalizeSeverity(bracket[1]) ? match : null;
}

function hasContent(draft: Draft): boolean {
  return draft.header.trim().length > 0 || Object.keys(draft.fields).length > 0;
}

/** Yanıt metnini ayrıştırır; yapı bulunamazsa `structured: false` döner. */
export function parseReviewReport(text: string | null | undefined): ReviewReport {
  const lines = (text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const drafts: Draft[] = [];
  let draft: Draft | null = null;
  let noFindings = false;
  let verdictRaw: string | null = null;
  let verdictPending = false;
  let rationale: string | null = null;
  let inRationale = false;

  const closeDraft = () => {
    if (draft && hasContent(draft)) drafts.push(draft);
    draft = null;
  };

  for (const raw of lines) {
    if (/^\s*(?:```|~~~)/u.test(raw)) continue;
    const line = cleanLine(raw);
    if (!line) {
      if (draft) draft.current = null;
      inRationale = false;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line)) continue;

    const header = FINDING_HEADER_RE.exec(line) ?? numberedSeverityHeader(line);
    if (header) {
      closeDraft();
      inRationale = false;
      draft = emptyDraft(true, header[2] ?? '');
      continue;
    }

    if (NO_FINDINGS_RE.test(line)) {
      closeDraft();
      noFindings = true;
      continue;
    }

    const verdict = VERDICT_RE.exec(line);
    if (verdict && /^(?:final\s+)?(?:verdict|karar)\b/iu.test(line)) {
      closeDraft();
      inRationale = false;
      const value = verdict[1]?.trim() ?? '';
      if (value) {
        verdictRaw = value;
        verdictPending = false;
      } else {
        verdictPending = true;
      }
      continue;
    }
    if (verdictPending) {
      verdictRaw = line;
      verdictPending = false;
      continue;
    }

    const rationaleMatch = RATIONALE_RE.exec(line);
    if (rationaleMatch && verdictRaw !== null) {
      rationale = rationaleMatch[1]?.trim() || null;
      inRationale = true;
      continue;
    }
    if (inRationale) {
      rationale = rationale ? `${rationale} ${line}` : line;
      continue;
    }

    // "1. Severity: high" gibi numaralı alan satırlarında numara atılır.
    const numbered = NUMBERED_RE.exec(line);
    const fieldLine = numbered && FIELD_RE.test(numbered[2]!) ? numbered[2]! : line;
    const field = FIELD_RE.exec(fieldLine);
    const key = field ? fieldKeyFor(field[1]!) : null;
    if (field && key) {
      const value = field[2]?.trim() ?? '';
      const existing = draft?.fields[key];
      if (draft && existing !== undefined && key === 'failureScenario') {
        // "Failure scenario:" ardından "Impact:" gibi eş anlamlı alanlar birleştirilir.
        draft.fields[key] = value ? `${existing}\n${value}` : existing;
      } else {
        // Başlıksız bloklar: aynı alan ikinci kez gelirse yeni bulgu başlamıştır.
        if (!draft || existing !== undefined) {
          closeDraft();
          draft = emptyDraft(false);
        }
        const activeDraft: Draft = draft;
        activeDraft.fields[key] = value;
      }
      draft.current = key;
      continue;
    }

    if (draft?.current) {
      const previous = draft.fields[draft.current] ?? '';
      draft.fields[draft.current] = previous ? `${previous}\n${line}` : line;
    }
  }
  closeDraft();

  const findings: ReviewFinding[] = [];
  for (const candidate of drafts) {
    const finding = finalizeDraft(candidate, findings.length + 1);
    if (finding) findings.push(finding);
  }
  const verdict = normalizeVerdict(verdictRaw);
  return {
    findings,
    verdict,
    verdictRationale: rationale,
    noFindings: noFindings && findings.length === 0,
    structured: findings.length > 0 || noFindings || verdict !== null,
  };
}
