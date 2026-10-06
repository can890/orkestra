import { LogHealthStore } from '@core/features/log-health/browser/log-health-store';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

const logHealthStoreToken = scopedStoreToken<LogHealthStore>('logHealth.store');

export const logHealthAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: logHealthStoreToken,
    create: () => new LogHealthStore(),
    activate: (store) => store.start(),
    dispose: (store) => void store.dispose(),
  }),
];

/** Uygulama kapsamlı günlük sağlığı deposu. */
export function getLogHealthStore(): LogHealthStore {
  return getAppStores().get(logHealthStoreToken);
}
