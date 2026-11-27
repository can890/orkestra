import type {
  AcpElicitationAction,
  AcpElicitationContent,
  AcpElicitationRequest,
} from '#runtimes/acp/api';

const RECOMMENDED_PREFIX_RE = /^\s*\((?:Recommended|Önerilen)\)\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*\((?:Recommended|Önerilen)\)\s*$/i;
const COMPANION_SUFFIX_RE = /^(.+?)(?:_other|_custom|_write_in|Other|Custom)$/;

function stripRecommended(text: string): string {
  return text.replace(RECOMMENDED_PREFIX_RE, '').replace(RECOMMENDED_SUFFIX_RE, '').trim() || text;
}

function isPlainStringProp(prop: Record<string, unknown>): boolean {
  const type = typeof prop.type === 'string' ? prop.type : 'string';
  return (
    type === 'string' &&
    !Array.isArray(prop.oneOf) &&
    !Array.isArray(prop.anyOf) &&
    !Array.isArray(prop.enum)
  );
}

function companionTargetKey(
  key: string,
  prop: Record<string, unknown>,
  allKeys: ReadonlySet<string>
): string | null {
  const meta = prop._meta;
  if (meta && typeof meta === 'object') {
    const marker = (meta as Record<string, unknown>)._askUserQuestionCustomAnswer;
    if (marker && typeof marker === 'object') {
      const rec = marker as Record<string, unknown>;
      if (rec.isCustomAnswer === true && typeof rec.questionId === 'string' && rec.questionId) {
        return rec.questionId;
      }
    }
  }
  if (!isPlainStringProp(prop)) return null;
  const match = COMPANION_SUFFIX_RE.exec(key);
  if (match && match[1] && allKeys.has(match[1])) {
    return match[1];
  }
  return null;
}

function buildOptionLabelMap(prop: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const sources: unknown[] = [prop.oneOf, prop.anyOf, prop.enum];
  if (prop.items && typeof prop.items === 'object') {
    const items = prop.items as Record<string, unknown>;
    sources.push(items.anyOf, items.oneOf, items.enum);
  }
  const enumNames = Array.isArray(prop.enumNames)
    ? prop.enumNames
    : prop.items && typeof prop.items === 'object' && Array.isArray((prop.items as Record<string, unknown>).enumNames)
      ? ((prop.items as Record<string, unknown>).enumNames as unknown[])
      : undefined;

  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (let i = 0; i < src.length; i++) {
      const item = src[i];
      if (typeof item === 'string') {
        const display =
          enumNames && typeof enumNames[i] === 'string' && enumNames[i].trim()
            ? enumNames[i].trim()
            : item;
        map.set(item, stripRecommended(display));
      } else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const value =
          typeof rec.const === 'string'
            ? rec.const
            : typeof rec.value === 'string'
              ? rec.value
              : typeof rec.title === 'string'
                ? rec.title
                : '';
        if (!value) continue;
        const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : value;
        const sep = /\s+(?:-|—)\s+/.exec(title);
        const cleanTitle = sep && sep.index > 0 ? title.slice(0, sep.index).trim() : title;
        map.set(value, stripRecommended(cleanTitle));
      }
    }
  }
  return map;
}

/**
 * Kullanıcının etkileşimli soru kartına verdiği yanıtı anlık sohbette kalıcı olarak
 * gösterilecek temiz Markdown soru-cevap kaydına dönüştürür.
 */
export function formatElicitationTranscriptSummary(
  request: AcpElicitationRequest,
  action: AcpElicitationAction,
  content?: AcpElicitationContent
): string | null {
  if (action === 'cancel') return null;

  if (request.mode === 'url') {
    const title = request.message.trim() || 'Bağlantı onayı';
    const answer = action === 'decline' ? '*Atlandı*' : 'Tamamlandı';
    return `**${title}**\n${answer}`;
  }

  const schema = request.requestedSchema;
  const propsRaw =
    schema && typeof schema === 'object' ? (schema as Record<string, unknown>).properties : null;
  if (!propsRaw || typeof propsRaw !== 'object') {
    const title = request.message.trim();
    if (!title) return null;
    return `**${title}**\n${action === 'decline' ? '*Atlandı*' : 'Onaylandı'}`;
  }

  const entries = Object.entries(propsRaw as Record<string, unknown>);
  const allKeys = new Set(entries.map(([k]) => k));
  const companionByTarget = new Map<string, string>();
  const consumed = new Set<string>();

  for (const [key, val] of entries) {
    if (!val || typeof val !== 'object') continue;
    const target = companionTargetKey(key, val as Record<string, unknown>, allKeys);
    if (target) {
      companionByTarget.set(target, key);
      consumed.add(key);
    }
  }

  const primary = entries.filter(([k]) => !consumed.has(k));
  const singleField = primary.length === 1;
  const blocks: string[] = [];

  for (let idx = 0; idx < primary.length; idx++) {
    const [key, val] = primary[idx]!;
    if (!val || typeof val !== 'object') continue;
    const prop = val as Record<string, unknown>;
    const title = typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : undefined;
    const description =
      typeof prop.description === 'string' && prop.description.trim()
        ? prop.description.trim()
        : undefined;
    const prompt =
      description ??
      title ??
      (singleField && request.message.trim() ? request.message.trim() : key);

    let answerText: string;
    if (action === 'decline') {
      answerText = '*Atlandı*';
    } else {
      const labels = buildOptionLabelMap(prop);
      const rawVal = content?.[key];
      const companionKey = companionByTarget.get(key);
      const customRaw = companionKey ? content?.[companionKey] : undefined;
      const customStr = typeof customRaw === 'string' ? customRaw.trim() : '';

      const parts: string[] = [];
      if (Array.isArray(rawVal)) {
        for (const v of rawVal) {
          if (typeof v === 'string' && v.trim()) {
            parts.push(labels.get(v) ?? stripRecommended(v));
          }
        }
      } else if (typeof rawVal === 'string' && rawVal.trim()) {
        parts.push(labels.get(rawVal) ?? stripRecommended(rawVal));
      } else if (typeof rawVal === 'boolean') {
        parts.push(rawVal ? 'Evet' : 'Hayır');
      } else if (typeof rawVal === 'number') {
        parts.push(String(rawVal));
      }

      if (customStr) {
        parts.push(customStr);
      }

      answerText = parts.length > 0 ? parts.join(', ') : '*Yanıt yok*';
    }

    const prefix = primary.length > 1 ? `${idx + 1}. ` : '';
    blocks.push(`**${prefix}${prompt}**\n${answerText}`);
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null;
}
