import { Button, MicroLabel } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { UpdateEverythingDialog } from '@core/features/updates/browser/update-everything-dialog';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';

export const UpdateSection = observer(function UpdateSection() {
  const update = getUpdateStore();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      {update.hasUpdate ? (
        <Button variant="secondary" size="xs" onClick={() => setModalOpen(true)}>
          Güncelle
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          title="Güncelleme Merkezini aç (Sovra + Ajanlar)"
          className="inline-flex h-6 cursor-pointer items-center rounded px-1 hover:bg-foreground/[0.06]"
        >
          <MicroLabel className="text-foreground-passive lowercase">
            v{update.currentVersion}
          </MicroLabel>
        </button>
      )}
      <UpdateEverythingDialog open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
});
