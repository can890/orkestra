import { useEffect, useMemo, useState } from 'react';
import { authLabel, type AccountView, type ProviderUsageView } from '@/core/mappers';
import { Empty, ErrorNote, Loading, WorkbenchHeader, providerDisplayName } from '../components';
import { GaugeIcon, RefreshIcon } from '../icons';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  QuotaRing,
  formatResetCountdown,
  primaryRemainingPercent,
  quotaTone,
} from '../ProviderBrand';

const CLOCK_TICK_MS = 30_000;

function formatBalanceValue(value: number): string {
  return value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
}

function isWindowExpired(resetsAt: string | null, now: number): boolean {
  if (!resetsAt) return false;
  const ts = Date.parse(resetsAt);
  return Number.isFinite(ts) && ts <= now;
}

/** "Limitler ve Hesaplar": tüm yapay zeka kotalarını kalan yüzde halkaları ve çubuklarla gösterir. */
export function AccountsScreen(props: {
  accounts: AccountView[];
  accountsLoading: boolean;
  accountsError: string | null;
  usage: Record<string, ProviderUsageView>;
  usageLoading: boolean;
  usageError: string | null;
  agentNames: Record<string, string>;
  hostName: string;
  onRefreshUsage: () => void;
  onOpenMenu: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const cards = useMemo(() => {
    const accountMap = new Map(props.accounts.map((a) => [a.providerId, a]));
    const orderedIds: string[] = [...CORE_USAGE_PROVIDERS];
    for (const acc of props.accounts) {
      if (
        !orderedIds.includes(acc.providerId) &&
        (acc.auth === 'authenticated' || props.usage[acc.providerId])
      ) {
        orderedIds.push(acc.providerId);
      }
    }
    for (const id of Object.keys(props.usage)) {
      if (!orderedIds.includes(id)) {
        orderedIds.push(id);
      }
    }
    return orderedIds
      .map((id) => ({
        providerId: id,
        account: accountMap.get(id),
        usage: props.usage[id],
      }))
      .sort((a, b) => {
        const aHas =
          (a.usage?.windows.length ?? 0) > 0 || (a.usage?.balances.length ?? 0) > 0 ? 1 : 0;
        const bHas =
          (b.usage?.windows.length ?? 0) > 0 || (b.usage?.balances.length ?? 0) > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return 0;
      });
  }, [props.accounts, props.usage]);

  const activeQuotaCount = cards.filter(
    (c) => (c.usage?.windows.length ?? 0) > 0 || (c.usage?.balances.length ?? 0) > 0
  ).length;
  const connectedCount = cards.filter(
    (c) =>
      c.account?.auth === 'authenticated' ||
      (c.usage?.windows.length ?? 0) > 0 ||
      (c.usage?.balances.length ?? 0) > 0
  ).length;
  const lowestRemaining = cards.reduce<{ providerId: string; pct: number } | null>((acc, card) => {
    const pct = primaryRemainingPercent(card.usage);
    if (pct === null) return acc;
    if (!acc || pct < acc.pct) return { providerId: card.providerId, pct };
    return acc;
  }, null);

  return (
    <main className="screen">
      <WorkbenchHeader
        title="Yapay Zeka Limitleri"
        subtitle={
          activeQuotaCount > 0
            ? `${activeQuotaCount} sağlayıcıdan canlı kota (${props.hostName})`
            : `${props.hostName} oturumlarından okunur`
        }
        onMenu={props.onOpenMenu}
        trailing={
          <button
            type="button"
            className={`wb-icon-btn sm ${props.usageLoading ? 'is-spinning' : ''}`}
            disabled={props.usageLoading}
            onClick={props.onRefreshUsage}
            aria-label="Limitleri yenile"
          >
            <RefreshIcon size={16} />
          </button>
        }
      />

      <div className="screen-body with-dock">
        <ErrorNote message={props.accountsError ?? props.usageError} />
        {props.accountsLoading && props.usageLoading && cards.length === 0 ? (
          <Loading label="Yapay zeka limitleri sorgulanıyor…" />
        ) : null}

        {cards.length > 0 ? (
          <section className="limits-summary-strip" aria-label="Kota özeti">
            <div className="limits-summary-tile">
              <span className="limits-summary-label">Bağlı hesap</span>
              <strong className="limits-summary-val">{connectedCount}</strong>
            </div>
            <div className="limits-summary-tile">
              <span className="limits-summary-label">Canlı kota</span>
              <strong className="limits-summary-val">{activeQuotaCount}</strong>
            </div>
            <div className="limits-summary-tile">
              <span className="limits-summary-label">En sıkışık</span>
              <strong
                className={`limits-summary-val ${
                  lowestRemaining ? `is-${quotaTone(lowestRemaining.pct)}` : ''
                }`}
              >
                {lowestRemaining ? `%${lowestRemaining.pct}` : '—'}
              </strong>
            </div>
          </section>
        ) : null}

        {!props.accountsLoading && cards.length === 0 ? (
          <Empty icon={<GaugeIcon size={30} />} title="Sağlayıcı bulunamadı">
            Masaüstü Sovra ayarlarından bir yapay zeka hesabı bağladığınızda limitler burada
            görünür.
          </Empty>
        ) : null}

        <div className="limit-card-stack">
          {cards.map(({ providerId, account, usage }) => (
            <LimitCard
              key={providerId}
              providerId={providerId}
              account={account}
              usage={usage}
              loading={props.usageLoading && !usage}
              now={now}
              agentNames={props.agentNames}
            />
          ))}
        </div>

        <p className="footnote">
          Limitler {props.hostName} üzerindeki yerel ajan oturumlarından okunur; erişim anahtarları
          telefona gönderilmez.
        </p>
      </div>
    </main>
  );
}

function LimitCard(props: {
  providerId: string;
  account: AccountView | undefined;
  usage: ProviderUsageView | undefined;
  loading: boolean;
  now: number;
  agentNames: Record<string, string>;
}) {
  const { providerId, account, usage, now } = props;
  const displayName = account?.name || providerDisplayName(providerId, props.agentNames);
  const remaining = primaryRemainingPercent(usage);
  const hasWindows = (usage?.windows.length ?? 0) > 0;
  const hasBalances = (usage?.balances.length ?? 0) > 0;
  const hasData = hasWindows || hasBalances;
  const connected = hasData || account?.auth === 'authenticated';
  const email = usage?.account || account?.account;

  const sortedWindows = useMemo(() => {
    if (!usage?.windows.length) return [];
    const active = usage.windows.filter((w) => !isWindowExpired(w.resetsAt, now));
    const expired = usage.windows.filter((w) => isWindowExpired(w.resetsAt, now));
    return [...active, ...expired];
  }, [usage, now]);

  const fallbackNote =
    usage?.message ||
    account?.message ||
    (usage?.status === 'auth-required'
      ? 'Hesap erişimi gerekli — masaüstü Sovra ayarlarından oturum açın.'
      : usage?.status === 'error'
        ? 'Kullanım verisi alınamadı.'
        : 'Bu sağlayıcı için okunabilir kota bilgisi alınamadı.');

  return (
    <section className={`limit-card ${hasData ? 'has-data' : ''}`}>
      <div className="limit-card-head">
        <div className="limit-card-id">
          <ProviderAvatar providerId={providerId} size="md" names={props.agentNames} />
          <div className="limit-card-titles">
            <div className="limit-name-row">
              <strong className="limit-name">{displayName}</strong>
              {usage?.plan ? <span className="plan-pill">{usage.plan}</span> : null}
            </div>
            <span className="limit-sub">
              {email || (connected ? 'Bağlı' : authLabel(account?.auth ?? 'unauthenticated'))}
            </span>
          </div>
        </div>
        {remaining !== null ? (
          <QuotaRing remainingPercent={remaining} size={46} stroke={4} />
        ) : (
          <span className={`auth-badge is-${connected ? 'authenticated' : 'unauthenticated'}`}>
            {props.loading ? 'Sorgulanıyor…' : connected ? 'Aktif' : 'Giriş yok'}
          </span>
        )}
      </div>

      {hasWindows ? (
        <div className="limit-windows">
          {sortedWindows.map((window, index) => {
            const rem = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
            const expired = isWindowExpired(window.resetsAt, now);
            const tone = expired ? 'muted' : quotaTone(rem);
            const reset = formatResetCountdown(window.resetsAt);
            return (
              <div
                key={`${window.label}-${index}`}
                className={`limit-window-row ${expired ? 'is-expired' : ''}`}
              >
                <div className="limit-window-top">
                  <span className="limit-window-label">{window.label}</span>
                  <span className={`limit-window-pct is-${tone}`}>%{rem} kaldı</span>
                </div>
                <div
                  className="meter-track"
                  role="progressbar"
                  aria-label={`${displayName} ${window.label}`}
                  aria-valuenow={rem}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={`meter-fill is-${tone}`} style={{ width: `${rem}%` }} />
                </div>
                <div className="limit-window-foot">
                  <span>%{Math.round(window.usedPercent)} kullanıldı</span>
                  {reset ? (
                    <span>
                      {expired ? 'Yenilendi · yeni ölçüm bekleniyor' : `Yenilenme: ${reset}`}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : !props.loading ? (
        <p className="limit-note">{fallbackNote}</p>
      ) : null}

      {hasBalances ? (
        <div className="balance-chips">
          {usage!.balances.map((b, idx) => (
            <span key={`${b.label}-${idx}`} className="balance-chip">
              <span className="balance-label">{b.label}</span>
              <strong className="balance-val mono">
                {formatBalanceValue(b.value)} {b.unit}
              </strong>
            </span>
          ))}
        </div>
      ) : null}

      {hasWindows && usage?.message ? <p className="limit-note">{usage.message}</p> : null}

      {usage?.refreshError ? (
        <p className="limit-note is-warn">
          Son yenileme başarısız: {usage.refreshError} Önceki ölçüm gösteriliyor.
        </p>
      ) : null}

      {usage?.source ? <div className="limit-source">{usage.source}</div> : null}
    </section>
  );
}
