import { Button } from '@orkestra/ui/react/primitives';
import { SearchCheck } from 'lucide-react';
import { useOpenModal } from '@core/manifests/browser/modal-api';

/** Değişiklikler panelindeki "Değişiklikleri incele…" girişi. */
export function ReviewChangesButton({ projectId, taskId }: { projectId: string; taskId: string }) {
  const openReview = useOpenModal('codeReviewModal');
  return (
    <div className="border-t border-border px-2 pt-2">
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => void openReview({ projectId, taskId })}
      >
        <SearchCheck className="size-3.5" />
        Değişiklikleri incele…
      </Button>
    </div>
  );
}
