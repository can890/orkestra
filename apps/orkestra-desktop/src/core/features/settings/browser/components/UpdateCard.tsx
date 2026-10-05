import { UpdateCard as UpdateCardUi } from '@orkestra/ui/react/components';
import { observer } from 'mobx-react-lite';
import type React from 'react';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { toUpdateCardStatus } from './update-card-status';

export const UpdateCard = observer(function UpdateCard(): React.JSX.Element {
  const update = getUpdateStore();
  const state = update.state;
  const status = toUpdateCardStatus(state, update.availableVersion, {
    openRelease: () => update.openLatest(),
    install: () => update.install(),
  });

  return (
    <UpdateCardUi
      currentVersion={update.currentVersion}
      appName={PRODUCT_NAME}
      status={status}
      error={state.status === 'error' ? { message: state.message } : undefined}
      onCheckForUpdates={() => update.check()}
    />
  );
});
