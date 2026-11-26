import { Button, MicroLabel, Tooltip } from '@orkestra/ui/react/primitives';
import { CircleArrowUp } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { UpdateEverythingDialog } from '@core/features/updates/browser/update-everything-dialog';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { cn } from '@core/primitives/styling/browser/cn';

export const UpdateSection = observer(function UpdateSection({
  compact = false,
}: {
  compact?: boolean;
} = {}) {
  const update = getUpdateStore();
  const [modalOpen, setModalOpen] = useState(false);

  if (compact) {
    const versionLabel = update.currentVersion ? `v${update.currentVersion}` : '';
    const tooltipLabel = update.hasUpdate
      ? `Güncelleme hazır${update.availableVersion ? ` · v${update.availableVersion}` : ''}`
      : `Güncelleme Merkezi${versionLabel ? ` · ${versionLabel}` : ''}`;

    return (
      <>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                aria-label={tooltipLabel}
                className={cn(
                  'relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  update.hasUpdate
                    ? 'bg-foreground/[0.14] text-foreground ring-1 ring-accent/60 hover:bg-foreground/[0.20]'
                    : 'bg-foreground/[0.07] text-foreground-tertiary hover:bg-foreground/[0.13] hover:text-foreground'
                )}
              >
                <CircleArrowUp className="size-[18px]" strokeWidth={1.75} />
                {update.hasUpdate && (
                  <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-accent ring-2 ring-(--em-surface)" />
                )}
              </button>
            }
          />
          <Tooltip.Content side="top">{tooltipLabel}</Tooltip.Content>
        </Tooltip.Root>
        <UpdateEverythingDialog open={modalOpen} onOpenChange={setModalOpen} />
      </>
    );
  }

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
