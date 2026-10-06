import { UpdateCard as UpdateCardUi } from '@orkestra/ui/react/components';
import { SettingsCard } from '@orkestra/ui/react/patterns';
import { observer } from 'mobx-react-lite';
import type React from 'react';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { AutoDownloadUpdatesRow } from './AutoDownloadUpdatesRow';
import { toUpdateCardStatus } from './update-card-status';

export const UpdateCard = observer(function UpdateCard(): React.JSX.Element {
  const update = getUpdateStore();
  const state = update.state;
  const status = toUpdateCardStatus(state, update, {
    openRelease: () => update.openLatest(),
    download: () => update.download(),
    install: () => update.install(),
  });

  return (
    <div className="flex flex-col gap-3">
      <UpdateCardUi
        currentVersion={update.currentVersion}
        appName={PRODUCT_NAME}
        status={status}
        error={state.status === 'error' ? { message: state.message } : undefined}
        onCheckForUpdates={() => update.check()}
      />
      <SettingsCard>
        <AutoDownloadUpdatesRow />
      </SettingsCard>
    </div>
  );
});
