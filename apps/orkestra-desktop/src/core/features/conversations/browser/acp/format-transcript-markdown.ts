import type { ChatItem, PrefixTranscriptTurn, TranscriptTurn } from '@orkestra/chat-ui';
import { toolGroupDisplayLabel } from '@orkestra/core/runtimes/acp/api/client';

export type ExportableTurn =
  | TranscriptTurn
  | PrefixTranscriptTurn
  | {
      id: string;
      seq?: number;
      items: readonly (ChatItem | Record<string, unknown>)[];
      outcome?: TranscriptTurn['outcome'];
    };

export type FormatTranscriptMarkdownInput = {
  title?: string | null;
  providerId?: string | null;
  model?: string | null;
  exportedAt?: Date;
  turns: readonly ExportableTurn[];
};

const MAX_TOOL_OUTPUT_CHARS = 1500;
const MAX_THINKING_CHARS = 3000;

function trimBlock(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n… (kısaltıldı)`;
}

function safeFence(content: string, lang = ''): string {
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${content}\n${fence}`;
}

function formatLineDiffPreview(oldText: string | null, newText: string): string {
  const lines: string[] = [];
  if (oldText !== null && oldText !== '') {
    for (const line of oldText.split('\n').slice(0, 20)) {
      lines.push(`- ${line}`);
    }
  }
  if (newText !== '') {
    for (const line of newText.split('\n').slice(0, 20)) {
      lines.push(`+ ${line}`);
    }
  }
  return lines.join('\n');
}

function formatItemAsMarkdown(rawItem: ChatItem | Record<string, unknown>): string | null {
  if (!rawItem || typeof rawItem !== 'object' || !('kind' in rawItem)) return null;
  const item = rawItem as ChatItem;

  switch (item.kind) {
    case 'message': {
      const text = item.text.trim();
      if (!text) return null;
      if (item.role === 'user') return `### Kullanıcı\n\n${text}`;
      if (item.role === 'assistant') return `### Asistan\n\n${text}`;
      return `<details>\n<summary>Düşünme</summary>\n\n${trimBlock(text, MAX_THINKING_CHARS)}\n\n</details>`;
    }

    case 'thinking': {
      const text = item.text.trim();
      if (!text) return null;
      const secs =
        typeof item.durationMs === 'number' && item.durationMs > 0
          ? ` (${(item.durationMs / 1000).toFixed(1)} sn)`
          : '';
      return `<details>\n<summary>Düşünme${secs}</summary>\n\n${trimBlock(text, MAX_THINKING_CHARS)}\n\n</details>`;
    }

    case 'handoff-divider': {
      return `---\n\n> Ajan devri: **${item.fromLabel}** → **${item.toLabel}**`;
    }

    case 'execute-tool-call': {
      const command = (item.command ?? item.title ?? '').trim();
      const output = item.outputText ? trimBlock(item.outputText, MAX_TOOL_OUTPUT_CHARS) : '';
      const parts = [`- **Komut:** \`${command || 'shell'}\``];
      if (output) parts.push('', safeFence(output, 'sh'));
      return parts.join('\n');
    }

    case 'execute': {
      const command = (item.command || item.inputSummary || 'shell').trim();
      const output = item.outputLines?.length
        ? trimBlock(item.outputLines.join('\n'), MAX_TOOL_OUTPUT_CHARS)
        : '';
      const parts = [`- **Komut:** \`${command}\``];
      if (output) parts.push('', safeFence(output, 'sh'));
      return parts.join('\n');
    }

    case 'read-tool-call':
      return `- **Dosya okuma:** \`${item.title}\``;

    case 'create-file-tool-call':
      return `- **Dosya oluşturma:** \`${item.path}\``;

    case 'modify-file-tool-call': {
      const preview = formatLineDiffPreview(item.oldText, item.newText);
      return preview
        ? `- **Dosya düzenleme:** \`${item.path}\`\n\n${safeFence(preview, 'diff')}`
        : `- **Dosya düzenleme:** \`${item.path}\``;
    }

    case 'delete-file-tool-call':
      return `- **Dosya silme:** \`${item.path}\``;

    case 'search-tool-call':
      return `- **Arama:** \`${item.query}\`${typeof item.matchCount === 'number' ? ` (${item.matchCount} eşleşme)` : ''}`;

    case 'mcp-tool-call':
      return `- **MCP aracı:** \`${item.server ? `${item.server}/` : ''}${item.tool}\``;

    case 'web-fetch-tool-call':
      return `- **Web okuma:** ${item.pageTitle ? `${item.pageTitle} (${item.url})` : item.url}`;

    case 'spawn-subagent-tool-call':
      return `- **Alt ajan (${item.name}):** ${item.title || item.status}${item.outputText ? `\n\n> ${trimBlock(item.outputText, 800).replaceAll('\n', '\n> ')}` : ''}`;

    case 'create-plan-tool-call':
      return `- **Plan:** ${item.title || item.planId}`;

    case 'unknown-tool-call':
      return `- **Araç (${item.name}):** ${item.title || item.status}`;

    case 'tool-group': {
      const nested = item.children.map((child) => formatItemAsMarkdown(child)).filter(Boolean);
      const label = toolGroupDisplayLabel(item.children);
      if (nested.length === 0) return `- **${label}** (${item.status})`;
      return `- **${label}**\n\n${nested.join('\n')}`;
    }

    case 'file-op': {
      const opLabels: Record<string, string> = {
        read: 'Okuma',
        edit: 'Düzenleme',
        delete: 'Silme',
        move: 'Taşıma',
      };
      const files = item.ops.map((o) => `\`${o.path}\``).join(', ');
      return `- **${opLabels[item.op] ?? item.op}:** ${files || item.op}`;
    }

    case 'diff': {
      const preview = formatLineDiffPreview(item.oldText, item.newText);
      return preview
        ? `- **Diff:** \`${item.path}\`\n\n${safeFence(preview, 'diff')}`
        : `- **Diff:** \`${item.path}\``;
    }

    case 'tool':
      return `- **Araç (${item.name}):** ${item.inputSummary ?? item.status}`;

    case 'subagent':
      return `- **Alt ajan:** ${item.name} (${item.phase})`;

    case 'plan': {
      const rows = item.entries.map((entry) => {
        const mark =
          entry.status === 'completed' ? 'x' : entry.status === 'in_progress' ? '-' : ' ';
        return `- [${mark}] ${entry.content}`;
      });
      return rows.length > 0 ? `**Plan:**\n\n${rows.join('\n')}` : null;
    }

    case 'resource-link':
      return `- **Kaynak:** [${item.title ?? item.name}](${item.uri})`;

    default:
      return null;
  }
}

export function formatTranscriptAsMarkdown(input: FormatTranscriptMarkdownInput): string {
  const title = input.title?.trim() || 'Sovra Sohbet Transkripti';
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();

  const metaParts: string[] = [];
  if (input.providerId) metaParts.push(`**Ajan:** ${input.providerId}`);
  if (input.model) metaParts.push(`**Model:** ${input.model}`);
  metaParts.push(`**Tarih:** ${exportedAt}`);

  const sections: string[] = [`# ${title}`, metaParts.join(' · ')];

  for (const turn of input.turns) {
    for (const item of turn.items) {
      const rendered = formatItemAsMarkdown(item);
      if (rendered) sections.push(rendered);
    }
    if (turn.outcome?.kind === 'error') {
      sections.push(`> Hata: ${turn.outcome.message ?? turn.outcome.reason}`);
    } else if (turn.outcome?.kind === 'cancelled') {
      sections.push(`> *Tur kullanıcı tarafından durduruldu.*`);
    }
  }

  return `${sections.join('\n\n')}\n`;
}

export function buildTranscriptMarkdownFilename(title: string | null | undefined): string {
  const slug = (title ?? 'sohbet')
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'sohbet'}.md`;
}
