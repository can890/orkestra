import { useEffect, useState } from 'react';
import {
  authLabel,
  mapAccounts,
  mapUsage,
  type AccountView,
  type ProviderUsageView,
} from '@/core/mappers';
import { LOCAL_HOST, REMOTE_TOPICS, topicOf, type RemoteApi } from '@/core/wire-client';
import { describeCallError } from '@/core/wire-client';
import { Empty, ErrorNote, Header, Loading, shortTime } from '../components';
import { useLive } from '../hooks';

/** "Bağlı hesaplar": salt okunur; sağlayıcı oturumları ve kullanım limitleri. */
export function AccountsScreen(props: { api: RemoteApi }) {
  const accounts = useLive(
    props.api,
    topicOf(REMOTE_TOPICS.authList, { host: LOCAL_HOST }),
    mapAccounts
  );
  const [usage, setUsage] = useState<Record<string, ProviderUsageView>>({});
  const [usageError, setUsageError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const ids = accounts.data
    ?.filter((account) => account.auth === 'authenticated')
    .map((account) => account.providerId)
    .slice(0, 12)
    .join(',');

  useEffect(() => {
    if (!ids) return;
    let active = true;
    setRefreshing(true);
    props.api
      .call('usageLimits.get', {
        host: LOCAL_HOST,
        providerIds: ids.split(','),
        ...(tick > 0 ? { force: true } : {}),
      })
      .then(
        (data) => {
          if (!active) return;
          setUsage(Object.fromEntries(mapUsage(data).map((entry) => [entry.providerId, entry])));
          setUsageError(null);
        },
        (error: unknown) => active && setUsageError(describeCallError(error))
      )
      .finally(() => active && setRefreshing(false));
    return () => {
      active = false;
    };
  }, [props.api, ids, tick]);

  return (
    <main className="screen">
      <Header title="Bağlı hesaplar" subtitle="Yalnızca görüntüleme" />
      <ErrorNote message={accounts.error ?? usageError} />
      {accounts.loading ? <Loading /> : null}
      {accounts.data?.length === 0 ? <Empty>Bağlı sağlayıcı hesabı yok.</Empty> : null}
      <div className="list">
        {accounts.data?.map((account) => (
          <AccountCard
            key={account.providerId}
            account={account}
            usage={usage[account.providerId]}
          />
        ))}
      </div>
      {ids ? (
        <button
          className="button"
          disabled={refreshing}
          onClick={() => setTick((value) => value + 1)}
        >
          {refreshing ? 'Yenileniyor…' : 'Kullanımı yenile'}
        </button>
      ) : null}
      <p className="hint">
        Hesap girişi ve ayarlar yalnızca masaüstünden yapılır; tokenlar telefona hiç gönderilmez.
      </p>
    </main>
  );
}

function AccountCard(props: { account: AccountView; usage: ProviderUsageView | undefined }) {
  const { account, usage } = props;
  return (
    <section className="card">
      <div className="row">
        <strong>{account.name}</strong>
        <span className={`chip chip-${account.auth}`}>{authLabel(account.auth)}</span>
      </div>
      {account.account ? <p className="hint">{account.account}</p> : null}
      {account.auth !== 'authenticated' && account.message ? (
        <p className="hint">{account.message}</p>
      ) : null}
      {usage ? (
        <>
          {usage.plan ? <p className="hint">Plan: {usage.plan}</p> : null}
          {usage.status !== 'available' ? (
            <p className="hint">
              Kullanım bilgisi alınamadı{usage.message ? `: ${usage.message}` : '.'}
            </p>
          ) : null}
          {usage.windows.map((window) => (
            <div key={window.label} className="meter">
              <div className="row small-text">
                <span>{window.label}</span>
                <span>%{Math.round(window.usedPercent)}</span>
              </div>
              <div
                className="bar"
                role="progressbar"
                aria-valuenow={Math.round(window.usedPercent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={window.usedPercent >= 90 ? 'bar-fill danger' : 'bar-fill'}
                  style={{ width: `${window.usedPercent}%` }}
                />
              </div>
              {window.resetsAt ? (
                <span className="hint">Yenilenme: {shortTime(window.resetsAt)}</span>
              ) : null}
            </div>
          ))}
          {usage.balances.map((balance) => (
            <p key={balance.label} className="hint">
              {balance.label}: {balance.value} {balance.unit}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}
