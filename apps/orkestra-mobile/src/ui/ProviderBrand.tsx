import antigravityLogo from '@/assets/providers/antigravity.svg';
import claudeLogo from '@/assets/providers/claude.svg';
import cursorLogo from '@/assets/providers/cursor.svg';
import kimiLogo from '@/assets/providers/kimi.svg';
import openaiLogo from '@/assets/providers/openai.svg';
import xaiLogo from '@/assets/providers/xai.svg';
import type { ProviderUsageView } from '@/core/mappers';
import { providerDisplayName } from './components';

export const CORE_USAGE_PROVIDERS = [
  'antigravity',
  'claude',
  'codex',
  'gemini',
  'kimi',
  'grok',
  'glm',
] as const;

type BrandMeta = {
  logo?: string;
  invertInDark?: boolean;
  tone: string;
  short: string;
};

const BRANDS: Record<string, BrandMeta> = {
  antigravity: { logo: antigravityLogo, tone: 'brand-antigravity', short: 'AG' },
  claude: { logo: claudeLogo, tone: 'brand-claude', short: 'CL' },
  'claude-code': { logo: claudeLogo, tone: 'brand-claude', short: 'CL' },
  codex: { logo: openaiLogo, invertInDark: true, tone: 'brand-codex', short: 'CX' },
  openai: { logo: openaiLogo, invertInDark: true, tone: 'brand-codex', short: 'OA' },
  kimi: { logo: kimiLogo, invertInDark: true, tone: 'brand-kimi', short: 'KM' },
  grok: { logo: xaiLogo, invertInDark: true, tone: 'brand-grok', short: 'GK' },
  cursor: { logo: cursorLogo, invertInDark: true, tone: 'brand-cursor', short: 'CR' },
  glm: { tone: 'brand-glm', short: 'ZM' },
  gemini: { tone: 'brand-antigravity', short: 'GM' },
};

export function ProviderAvatar(props: {
  providerId: string;
  size?: 'sm' | 'md' | 'lg';
  names?: Record<string, string>;
}) {
  const key = props.providerId.toLowerCase();
  const brand = BRANDS[key];
  const size = props.size ?? 'md';
  const label = providerDisplayName(props.providerId, props.names);
  return (
    <span
      className={`provider-avatar is-${size} ${brand?.tone ?? 'brand-default'}`}
      aria-hidden="true"
      title={label}
    >
      {brand?.logo ? (
        <img
          src={brand.logo}
          alt=""
          className={brand.invertInDark ? 'provider-logo invert-dark' : 'provider-logo'}
          draggable={false}
        />
      ) : (
        <span className="provider-monogram">{brand?.short ?? label.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}

/** Sağlayıcının en sıkışık penceresine göre kalan yüzdeyi (0–100) hesaplar. */
export function primaryRemainingPercent(usage: ProviderUsageView | undefined): number | null {
  if (!usage || usage.windows.length === 0) return null;
  let maxUsed = 0;
  for (const w of usage.windows) {
    if (w.usedPercent > maxUsed) maxUsed = w.usedPercent;
  }
  return Math.max(0, Math.min(100, Math.round(100 - maxUsed)));
}

export function quotaTone(remainingPercent: number): 'ok' | 'warn' | 'danger' {
  if (remainingPercent <= 10) return 'danger';
  if (remainingPercent <= 30) return 'warn';
  return 'ok';
}

export function QuotaRing(props: { remainingPercent: number; size?: number; stroke?: number }) {
  const size = props.size ?? 44;
  const stroke = props.stroke ?? 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, props.remainingPercent));
  const offset = circumference * (1 - pct / 100);
  const tone = quotaTone(pct);
  return (
    <div className="quota-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="quota-ring-bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          className={`quota-ring-fg is-${tone}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className={`quota-ring-text is-${tone}`}>%{pct}</span>
    </div>
  );
}

export function formatResetCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Yenilendi';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} dk sonra`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const restMin = mins % 60;
    return restMin ? `${hours} sa ${restMin} dk sonra` : `${hours} sa sonra`;
  }
  const days = Math.floor(hours / 24);
  const restHour = hours % 24;
  return restHour ? `${days} gün ${restHour} sa sonra` : `${days} gün sonra`;
}
