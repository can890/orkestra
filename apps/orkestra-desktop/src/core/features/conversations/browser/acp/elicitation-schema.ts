import type {
  AcpElicitationContent,
  AcpElicitationRequest,
} from '@orkestra/core/runtimes/acp/api/client';

export interface ElicitationChoiceOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export type ElicitationField =
  | {
      kind: 'single-select';
      key: string;
      header?: string;
      prompt: string;
      required: boolean;
      options: ElicitationChoiceOption[];
      customFieldKey?: string;
      customPlaceholder?: string;
      defaultValue?: string;
    }
  | {
      kind: 'multi-select';
      key: string;
      header?: string;
      prompt: string;
      required: boolean;
      options: ElicitationChoiceOption[];
      customFieldKey?: string;
      customPlaceholder?: string;
      defaultValue?: string[];
    }
  | {
      kind: 'boolean';
      key: string;
      header?: string;
      prompt: string;
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      kind: 'text';
      key: string;
      header?: string;
      prompt: string;
      required: boolean;
      inputType: 'text' | 'number' | 'integer';
      placeholder?: string;
      defaultValue?: string;
    };

export type ElicitationFieldValue = string | boolean | string[];

export interface ElicitationDraft {
  values: Record<string, ElicitationFieldValue>;
  customText: Record<string, string>;
}

const RECOMMENDED_PREFIX_RE = /^\s*\((?:Recommended|Önerilen)\)\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*\((?:Recommended|Önerilen)\)\s*$/i;

function normalizeOptionLabel(raw: string): { label: string; recommended: boolean } {
  if (RECOMMENDED_PREFIX_RE.test(raw)) {
    return { label: raw.replace(RECOMMENDED_PREFIX_RE, '').trim() || raw, recommended: true };
  }
  if (RECOMMENDED_SUFFIX_RE.test(raw)) {
    return { label: raw.replace(RECOMMENDED_SUFFIX_RE, '').trim() || raw, recommended: true };
  }
  return { label: raw, recommended: false };
}

function splitTitleAndDescription(
  rawTitle: string,
  explicitDescription?: string
): { title: string; description?: string } {
  if (explicitDescription) return { title: rawTitle, description: explicitDescription };
  const sepMatch = /\s+(?:-|—)\s+/.exec(rawTitle);
  if (!sepMatch || sepMatch.index <= 0) return { title: rawTitle };
  const left = rawTitle.slice(0, sepMatch.index).trim();
  const right = rawTitle.slice(sepMatch.index + sepMatch[0].length).trim();
  if (!left || !right) return { title: rawTitle };
  return { title: left, description: right };
}

function extractChoicesFromArray(arr: unknown, enumNames?: unknown): ElicitationChoiceOption[] {
  if (!Array.isArray(arr)) return [];
  const names = Array.isArray(enumNames) ? enumNames : undefined;
  const options: ElicitationChoiceOption[] = [];
  for (let idx = 0; idx < arr.length; idx++) {
    const item = arr[idx];
    if (typeof item === 'string') {
      const displayRaw =
        names && typeof names[idx] === 'string' && names[idx].trim() ? names[idx].trim() : item;
      const { title, description } = splitTitleAndDescription(displayRaw);
      const { label, recommended } = normalizeOptionLabel(title);
      options.push({
        value: item,
        label,
        ...(description ? { description } : {}),
        ...(recommended ? { recommended: true } : {}),
      });
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
      const rawTitle = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : value;
      const explicitDescription =
        typeof rec.description === 'string' && rec.description.trim()
          ? rec.description.trim()
          : undefined;
      const { title, description } = splitTitleAndDescription(rawTitle, explicitDescription);
      const { label, recommended } = normalizeOptionLabel(title);
      options.push({
        value,
        label,
        ...(description ? { description } : {}),
        ...(recommended ? { recommended: true } : {}),
      });
    }
  }
  return options;
}

function customAnswerTargetOf(prop: Record<string, unknown>): string | null {
  const meta = prop._meta;
  if (!meta || typeof meta !== 'object') return null;
  const marker = (meta as Record<string, unknown>)._askUserQuestionCustomAnswer;
  if (!marker || typeof marker !== 'object') return null;
  const record = marker as Record<string, unknown>;
  if (record.isCustomAnswer !== true) return null;
  return typeof record.questionId === 'string' && record.questionId ? record.questionId : null;
}

/**
 * ACP `elicitation/create` JSON Schema'sını (Claude AskUserQuestion, Antigravity ask_question,
 * Codex request_user_input ve standart MCP elicitation formları) sade arayüz alanlarına çevirir.
 */
export function parseElicitationFields(request: AcpElicitationRequest): ElicitationField[] {
  const schema = request.requestedSchema;
  if (!schema || typeof schema !== 'object') return [];
  const propsRaw = (schema as Record<string, unknown>).properties;
  if (!propsRaw || typeof propsRaw !== 'object') return [];

  const requiredSet = new Set(
    Array.isArray((schema as Record<string, unknown>).required)
      ? ((schema as Record<string, unknown>).required as unknown[]).filter(
          (k): k is string => typeof k === 'string'
        )
      : []
  );

  const entries = Object.entries(propsRaw as Record<string, unknown>);
  // Claude / Codex köprülerinin `question_<n>_custom` alanlarını ebeveyn soruya bağla.
  const customCompanionByTarget = new Map<string, { key: string; description?: string }>();
  const consumedKeys = new Set<string>();
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const prop = value as Record<string, unknown>;
    const target = customAnswerTargetOf(prop);
    if (target) {
      customCompanionByTarget.set(target, {
        key,
        ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
      });
      consumedKeys.add(key);
    }
  }

  const primaryEntries = entries.filter(([key]) => !consumedKeys.has(key));
  const singleField = primaryEntries.length === 1;
  const fields: ElicitationField[] = [];

  for (const [key, value] of primaryEntries) {
    if (!value || typeof value !== 'object') continue;
    const prop = value as Record<string, unknown>;
    const type = typeof prop.type === 'string' ? prop.type : 'string';
    const title = typeof prop.title === 'string' && prop.title.trim() ? prop.title.trim() : undefined;
    const description =
      typeof prop.description === 'string' && prop.description.trim()
        ? prop.description.trim()
        : undefined;
    const required = requiredSet.has(key);
    const companion = customCompanionByTarget.get(key);

    // Tek soruluk formda ana soru `request.message` içinde gelebilir.
    const prompt = description ?? (singleField && request.message.trim() ? request.message.trim() : title ?? key);
    const header = title && title !== prompt ? title : undefined;

    if (type === 'array') {
      const items = prop.items && typeof prop.items === 'object' ? (prop.items as Record<string, unknown>) : {};
      const options = [
        ...extractChoicesFromArray(items.anyOf),
        ...extractChoicesFromArray(items.oneOf),
        ...extractChoicesFromArray(items.enum, items.enumNames),
      ];
      if (options.length > 0) {
        fields.push({
          kind: 'multi-select',
          key,
          ...(header ? { header } : {}),
          prompt,
          required,
          options,
          ...(companion
            ? {
                customFieldKey: companion.key,
                customPlaceholder: 'Diğer (kendi cevabını ekle)…',
              }
            : {}),
          ...(Array.isArray(prop.default)
            ? { defaultValue: prop.default.filter((v): v is string => typeof v === 'string') }
            : {}),
        });
        continue;
      }
    }

    if (type === 'string') {
      const options = [
        ...extractChoicesFromArray(prop.oneOf),
        ...extractChoicesFromArray(prop.anyOf),
        ...extractChoicesFromArray(prop.enum, prop.enumNames),
      ];
      if (options.length > 0) {
        fields.push({
          kind: 'single-select',
          key,
          ...(header ? { header } : {}),
          prompt,
          required,
          options,
          ...(companion
            ? {
                customFieldKey: companion.key,
                customPlaceholder: 'Diğer (kendi cevabını yaz veya not ekle)…',
              }
            : {}),
          ...(typeof prop.default === 'string' ? { defaultValue: prop.default } : {}),
        });
        continue;
      }
    }

    if (type === 'boolean') {
      fields.push({
        kind: 'boolean',
        key,
        ...(header ? { header } : {}),
        prompt,
        required,
        ...(typeof prop.default === 'boolean' ? { defaultValue: prop.default } : {}),
      });
      continue;
    }

    fields.push({
      kind: 'text',
      key,
      ...(header ? { header } : {}),
      prompt,
      required,
      inputType: type === 'integer' ? 'integer' : type === 'number' ? 'number' : 'text',
      ...(description && title ? { placeholder: description } : {}),
      ...(prop.default !== undefined && prop.default !== null
        ? { defaultValue: String(prop.default) }
        : {}),
    });
  }

  return fields;
}

export function initialElicitationDraft(fields: readonly ElicitationField[]): ElicitationDraft {
  const values: Record<string, ElicitationFieldValue> = {};
  const customText: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'multi-select') {
      values[field.key] = field.defaultValue ? [...field.defaultValue] : [];
    } else if (field.kind === 'boolean') {
      values[field.key] = field.defaultValue ?? false;
    } else if (field.kind === 'single-select') {
      values[field.key] = field.defaultValue ?? '';
    } else {
      values[field.key] = field.defaultValue ?? '';
    }
    if ((field.kind === 'single-select' || field.kind === 'multi-select') && field.customFieldKey) {
      customText[field.customFieldKey] = '';
    }
  }
  return { values, customText };
}

export function buildElicitationContent(
  fields: readonly ElicitationField[],
  draft: ElicitationDraft
): AcpElicitationContent {
  const content: AcpElicitationContent = {};
  for (const field of fields) {
    const raw = draft.values[field.key];
    if (field.kind === 'multi-select') {
      const selected = Array.isArray(raw) ? raw.filter((v) => v.length > 0) : [];
      if (selected.length > 0 || field.required) {
        content[field.key] = selected;
      }
      if (field.customFieldKey) {
        const custom = (draft.customText[field.customFieldKey] ?? '').trim();
        if (custom) content[field.customFieldKey] = custom;
      }
    } else if (field.kind === 'single-select') {
      const custom = field.customFieldKey
        ? (draft.customText[field.customFieldKey] ?? '').trim()
        : '';
      if (custom && field.customFieldKey) {
        content[field.customFieldKey] = custom;
      } else {
        const selected = typeof raw === 'string' ? raw : '';
        if (selected) {
          content[field.key] = selected;
        }
      }
    } else if (field.kind === 'boolean') {
      content[field.key] = Boolean(raw);
    } else {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) continue;
      if (field.inputType === 'number' || field.inputType === 'integer') {
        const parsed = field.inputType === 'integer' ? parseInt(text, 10) : Number(text);
        if (Number.isFinite(parsed)) content[field.key] = parsed;
      } else {
        content[field.key] = text;
      }
    }
  }
  return content;
}
