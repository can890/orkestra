import { defineUnit } from '@core/units';
import type { ChatHandoffDivider } from '@/model';
import { vars } from '@styles/theme.css';

function providerAccentColor(providerId: string): string {
  switch (providerId) {
    case 'claude':
      return '#d97757';
    case 'antigravity':
    case 'gemini':
      return '#60a5fa';
    case 'kimi':
      return '#38bdf8';
    case 'grok':
      return '#a78bfa';
    default:
      return vars.fg;
  }
}

function ProviderGlyph({ providerId }: { providerId: string }) {
  if (providerId === 'claude') {
    // 10-ray Anthropic/Claude starburst
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        style={{ 'flex-shrink': 0, color: '#d97757' }}
        aria-hidden="true"
      >
        <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07M8.17 2.76l7.66 18.48M21.24 8.17L2.76 15.83M15.83 2.76L8.17 21.24M21.24 15.83L2.76 8.17" />
      </svg>
    );
  }

  if (providerId === 'codex') {
    // OpenAI/Codex interwoven rosette
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ 'flex-shrink': 0 }}
        aria-hidden="true"
      >
        <path d="M12 3a4.5 4.5 0 0 1 3.9 2.25 4.5 4.5 0 0 1 3.9 6.75 4.5 4.5 0 0 1-3.9 6.75A4.5 4.5 0 0 1 8.1 18.75 4.5 4.5 0 0 1 4.2 12 4.5 4.5 0 0 1 8.1 5.25 4.5 4.5 0 0 1 12 3Z" />
        <polygon points="12 8.5 15 10.25 15 13.75 12 15.5 9 13.75 9 10.25" />
      </svg>
    );
  }

  if (providerId === 'antigravity') {
    // Antigravity lambda-arch glyph
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.3"
        stroke-linecap="round"
        stroke-linejoin="round"
        style={{ 'flex-shrink': 0, color: '#60a5fa' }}
        aria-hidden="true"
      >
        <path d="M5 19L12 4l7 15" />
        <path d="M8.5 13.5c2 1.2 5 1.2 7 0" />
      </svg>
    );
  }

  if (providerId === 'gemini') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ 'flex-shrink': 0, color: '#60a5fa' }}
        aria-hidden="true"
      >
        <path d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10Z" />
      </svg>
    );
  }

  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      style={{ 'flex-shrink': 0 }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

export const handoffDividerUnitDef = defineUnit<ChatHandoffDivider, { rowH: number }>({
  kind: 'handoff-divider',
  margin: { top: 12, bottom: 12 },
  vars: { rowH: 36 },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    return (
      <div
        data-handoff-divider="true"
        style={{
          height: `${props.vars.rowH}px`,
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          'user-select': 'none',
          width: '100%',
        }}
      >
        <div
          style={{
            flex: '1 1 0%',
            height: '1px',
            background: vars.border,
          }}
        />
        <div
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            gap: '6px',
            'font-size': '12.5px',
            color: vars.fgMuted,
            'white-space': 'nowrap',
            'max-width': '100%',
            overflow: 'hidden',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ 'flex-shrink': 0 }}
            aria-hidden="true"
          >
            <path d="M16 3l4 4-4 4" />
            <path d="M20 7H4" />
            <path d="M8 21l-4-4 4-4" />
            <path d="M4 17h16" />
          </svg>
          <span>{props.data.pending ? 'Bağlam aktarılıyor…' : 'Bağlam aktarımı'}</span>
          <span
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '4px',
              color: vars.fgMuted,
            }}
          >
            <ProviderGlyph providerId={props.data.fromProviderId} />
            <span>{props.data.fromLabel}</span>
          </span>
          <span style={{ 'font-size': '12px', color: vars.fgPassive }} aria-hidden="true">
            →
          </span>
          <span
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '4px',
              color: providerAccentColor(props.data.toProviderId),
              'font-weight': 500,
            }}
          >
            <ProviderGlyph providerId={props.data.toProviderId} />
            <span>{props.data.toLabel}</span>
          </span>
        </div>
        <div
          style={{
            flex: '1 1 0%',
            height: '1px',
            background: vars.border,
          }}
        />
      </div>
    );
  },
});
