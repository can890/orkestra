import { useMemo } from 'react';
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

/** "Limitler ve Hesaplar": tüm yapay zeka kotalarını kalan yüzde halkaları ve çubuklarla gösterir. */
export function AccountsScreen(props: {
  accounts: AccountView[];
  accountsLoading: boolean;
  accountsError: string | null;
  usage: Record<string, ProviderUsageView>;
  usageLoading: boolean;
  usageError: string | null;
  agentNames: Record<string, string>;
  onRefreshUsage: () => void;
  onOpenMenu: () => void;
}) {
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
    return orderedIds
      .map((id) => ({
        providerId: id,
        account: accountMap.get(id),
        usage: props.usage[id],
      }))
      .sort((a, b) => {
        const aHas = (a.usage?.windows.length ?? 0) > 0 ? 1 : 0;
        const bHas = (b.usage?.windows.length ?? 0) > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return 0;
      });
  }, [props.accounts, props.usage]);

  const activeQuotaCount = cards.filter((c) => (c.usage?.windows.length ?? 0) > 0).length;

  return (
    <main className="screen">
      <WorkbenchHeader
        title="Yapay Zeka Limitleri"
        subtitle={
          activeQuotaCount > 0
            ? `${activeQuotaCount} sağlayıcıdan canlı kota okundu`
            : 'Mac oturumlarından okunur'
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

        {!props.accountsLoading && cards.length === 0 ? (
          <Empty icon={<GaugeIcon size={30} />} title="Sağlayıcı bulunamadı">
            Masaüstü Orkestra ayarlarından bir yapay zeka hesabı bağladığınızda limitler burada
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
              agentNames={props.agentNames}
            />
          ))}
        </div>

        <p className="footnote">
          Limitler Mac&apos;inizdeki yerel ajan oturumlarından okunur; erişim anahtarları telefona
          gönderilmez.
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
  agentNames: Record<string, string>;
}) {
  const { providerId, account, usage } = props;
  const displayName = account?.name || providerDisplayName(providerId, props.agentNames);
  const remaining = primaryRemainingPercent(usage);
  const hasWindows = (usage?.windows.length ?? 0) > 0;
  const connected = hasWindows || account?.auth === 'authenticated';
  const email = usage?.account || account?.account;

  return (
    <section className={`limit-card ${hasWindows ? 'has-data' : ''}`}>
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
          {usage!.windows.map((window) => {
            const rem = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
            const tone = quotaTone(rem);
            const reset = formatResetCountdown(window.resetsAt);
            return (
              <div key={window.label} className="limit-window-row">
                <div className="limit-window-top">
                  <span className="limit-window-label">{window.label}</span>
                  <span className={`limit-window-pct is-${tone}`}>%{rem} kaldı</span>
                </div>
                <div
                  className="meter-track"
                  role="progressbar"
                  aria-valuenow={rem}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={`meter-fill is-${tone}`} style={{ width: `${rem}%` }} />
                </div>
                <div className="limit-window-foot">
                  <span>%{Math.round(window.usedPercent)} kullanıldı</span>
                  {reset ? <span>Yenilenme: {reset}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : !props.loading ? (
        <p className="limit-note">
          {usage?.message ||
            account?.message ||
            'Bu sağlayıcı için okunabilir kota bilgisi alınamadı.'}
        </p>
      ) : null}

      {usage && usage.balances.length > 0 ? (
        <div className="balance-chips">
          {usage.balances.map((b) => (
            <span key={b.label} className="balance-chip">
              <span className="balance-label">{b.label}</span>
              <strong className="balance-val mono">
                {Number.isInteger(b.value) ? b.value : b.value.toFixed(1)} {b.unit}
              </strong>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
