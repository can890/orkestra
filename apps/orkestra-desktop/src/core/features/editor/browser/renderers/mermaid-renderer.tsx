import { MermaidBlock } from '@orkestra/ui/react/components';
import { Button } from '@orkestra/ui/react/primitives';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';

export const MermaidEditorRenderer = observer(function MermaidEditorRenderer({
  tab,
}: {
  tab: FileTabResource;
}) {
  void tab.bufferVersion;
  const source = tab.bufferText();
  const [zoom, setZoom] = useState(1);

  return (
    <div className="flex h-full w-full flex-col bg-(--em-surface)">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-foreground-muted">
        <span>Mermaid Diyagramı</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            icon
            className="size-6"
            aria-label="Uzaklaştır"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <span className="min-w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button
            type="button"
            variant="ghost"
            icon
            className="size-6"
            aria-label="Yakınlaştır"
            onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.15).toFixed(2))))}
          >
            <ZoomIn className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            icon
            className="size-6"
            aria-label="Yakınlaştırmayı sıfırla"
            onClick={() => setZoom(1)}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            width: `${100 / zoom}%`,
          }}
        >
          <MermaidBlock source={source} />
        </div>
      </div>
    </div>
  );
});
