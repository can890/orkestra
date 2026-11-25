// Adapted from pingdotgg/t3code (MIT) — floating browser mini-player with corner pill and 8 resize handles.
import { Button, Tooltip } from '@orkestra/ui/react/primitives';
import { PanelRight, PictureInPicture2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { browserMiniPlayerStore } from '@core/features/browser/api/browser/browser-mini-player-store';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { cn } from '@core/primitives/styling/browser/cn';
import { useViewScopeInstance } from '@core/primitives/view-scopes/react';
import {
  startMiniPlayerGesture,
  stepMiniPlayerGesture,
  type MiniPlayerGesture,
} from './browser-mini-player-gesture';
import {
  MINI_PLAYER_CORNER_RADIUS,
  resolveMiniPlayerFrame,
  type ResizeDirection,
} from './browser-mini-player-layout';
import { useBrowserWebviewSlot } from './browser-webview-slot';

type ContainerRect = { left: number; top: number; width: number; height: number };

const EMPTY_RECT: ContainerRect = { left: 0, top: 0, width: 0, height: 0 };

const RESIZE_HANDLES: ReadonlyArray<{ direction: ResizeDirection; className: string }> = [
  { direction: 'n', className: 'top-0 left-3 right-3 h-1.5 -translate-y-0.5 cursor-ns-resize' },
  { direction: 's', className: 'bottom-0 left-3 right-3 h-1.5 translate-y-0.5 cursor-ns-resize' },
  { direction: 'w', className: 'left-0 top-3 bottom-3 w-1.5 -translate-x-0.5 cursor-ew-resize' },
  { direction: 'e', className: 'right-0 top-3 bottom-3 w-1.5 translate-x-0.5 cursor-ew-resize' },
  {
    direction: 'nw',
    className: 'top-0 left-0 size-3 -translate-x-0.5 -translate-y-0.5 cursor-nwse-resize',
  },
  {
    direction: 'ne',
    className: 'top-0 right-0 size-3 translate-x-0.5 -translate-y-0.5 cursor-nesw-resize',
  },
  {
    direction: 'sw',
    className: 'bottom-0 left-0 size-3 -translate-x-0.5 translate-y-0.5 cursor-nesw-resize',
  },
  {
    direction: 'se',
    className: 'bottom-0 right-0 size-3 translate-x-0.5 translate-y-0.5 cursor-nwse-resize',
  },
];

export const BrowserFloatingMiniPlayer = observer(function BrowserFloatingMiniPlayer({
  projectId,
  taskId,
  containerRef,
}: {
  projectId: string;
  taskId: string;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const taskScope = useViewScopeInstance();
  const entry = browserMiniPlayerStore.getEntry(projectId, taskId);
  const browserId = entry.browserId;
  const session = browserId ? browserSessionStore.getSession(browserId) : undefined;
  const isRightPanelOpen = browserRightPanelStore.isOpen(projectId, taskId);

  const [containerRect, setContainerRect] = useState<ContainerRect>(EMPTY_RECT);
  const [dragging, setDragging] = useState(false);
  const [pillOpen, setPillOpen] = useState(false);

  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<MiniPlayerGesture | null>(null);
  const captureRef = useRef<HTMLElement | null>(null);
  const handleTappedRef = useRef(false);

  const show = Boolean(browserId && session && !isRightPanelOpen);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !show) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setContainerRect((prev) =>
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height }
      );
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    const poll = window.setInterval(measure, 400);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.clearInterval(poll);
    };
  }, [containerRef, show]);

  const frame = show
    ? resolveMiniPlayerFrame(entry.geometry, {
        width: containerRect.width,
        height: containerRect.height,
      })
    : null;

  useBrowserWebviewSlot({
    browserId: browserId ?? '',
    placeholderRef,
    regionRef,
    show: Boolean(show && frame),
    interactive: !dragging,
    scopeId: taskScope?.id,
    highlight: null,
    zIndex: 48,
    cornerRadius: MINI_PLAYER_CORNER_RADIUS,
  });

  useEffect(() => {
    setPillOpen(false);
    gestureRef.current = null;
    setDragging(false);
  }, [browserId]);

  if (!show || !frame || !browserId || typeof document === 'undefined') {
    return null;
  }

  const fixedLeft = Math.round(containerRect.left + frame.x);
  const fixedTop = Math.round(containerRect.top + frame.y);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: ResizeDirection | null
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = startMiniPlayerGesture(event, direction, frame);
    captureRef.current = event.currentTarget;
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Test veya sentetik olaylarda pointer capture olmayabilir.
    }
  };

  const finishGesture = (): MiniPlayerGesture | null => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragging(false);
    if (gesture && captureRef.current) {
      try {
        if (captureRef.current.hasPointerCapture(gesture.pointerId)) {
          captureRef.current.releasePointerCapture(gesture.pointerId);
        }
      } catch {
        // İhmal et.
      }
    }
    captureRef.current = null;
    return gesture;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const step = stepMiniPlayerGesture(gesture, event, {
      width: containerRect.width,
      height: containerRect.height,
    });
    if (step.kind === 'ignore') return;
    if (step.kind === 'end') {
      finishGesture();
      return;
    }
    if (!gesture.moved) gestureRef.current = { ...gesture, moved: true };
    if (step.kind === 'move') {
      browserMiniPlayerStore.move(projectId, taskId, step.position);
      return;
    }
    browserMiniPlayerStore.resize(projectId, taskId, step.frame.width, step.frame.height, {
      x: step.frame.x,
      y: step.frame.y,
    });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    const gesture = finishGesture();
    handleTappedRef.current =
      event.type === 'pointerup' &&
      gesture?.direction === null &&
      gesture.pointerType === 'touch' &&
      !gesture.moved;
  };

  const handleLostCapture = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      gestureRef.current?.pointerId === event.pointerId &&
      captureRef.current === event.currentTarget
    ) {
      finishGesture();
    }
  };

  const toggleExternalPip = () => {
    void getBrowserClient().then((client) => {
      if (session?.pictureInPicture) {
        return client.closePipWindow({ browserId });
      }
      return client.openPipWindow({ browserId });
    });
  };

  // Kök portal `display: contents` kullanır; sabit katmanlar doğrudan kök stacking context'te
  // sıralanır: arka plan z-47 < webview z-48 < köşe kontrol hapı ve boyut tutamaçları z-49.
  return createPortal(
    <div style={{ display: 'contents' }}>
      <div
        aria-hidden
        className="pointer-events-none fixed bg-neutral-950 shadow-2xl"
        style={{
          left: fixedLeft,
          top: fixedTop,
          width: frame.width,
          height: frame.height,
          borderRadius: MINI_PLAYER_CORNER_RADIUS,
          zIndex: 47,
        }}
      />
      <div
        ref={regionRef}
        className="pointer-events-none fixed"
        style={{
          left: fixedLeft,
          top: fixedTop,
          width: frame.width,
          height: frame.height,
          borderRadius: MINI_PLAYER_CORNER_RADIUS,
          zIndex: 48,
        }}
      >
        <div
          ref={placeholderRef}
          className="h-full w-full"
          style={{ borderRadius: MINI_PLAYER_CORNER_RADIUS }}
        />
      </div>
      <section
        aria-label={session?.title || session?.currentUrl || 'Yüzen tarayıcı'}
        data-browser-mini-player={browserId}
        className="pointer-events-none fixed select-none"
        style={{
          left: fixedLeft,
          top: fixedTop,
          width: frame.width,
          height: frame.height,
          borderRadius: MINI_PLAYER_CORNER_RADIUS,
          zIndex: 49,
        }}
      >
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-white/15 ring-inset" />

        <div
          ref={handleRef}
          data-pill-open={pillOpen ? '' : undefined}
          className="group pointer-events-auto absolute top-2 right-2 z-[49] size-4 cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={(event) => beginGesture(event, null)}
          onPointerMove={handlePointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onLostPointerCapture={handleLostCapture}
          onClick={() => {
            if (!handleTappedRef.current) return;
            handleTappedRef.current = false;
            setPillOpen((open) => !open);
          }}
        >
          <div
            aria-hidden
            className="absolute top-0 right-0 size-2.5 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 group-data-pill-open:opacity-0"
          >
            <span className="block size-2 rounded-full bg-white/35 shadow-sm ring-1 ring-black/60" />
          </div>
          <div className="pointer-events-none absolute top-0 right-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-white/15 bg-neutral-950/90 p-0.5 opacity-0 shadow-lg backdrop-blur-xl transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-data-pill-open:pointer-events-auto group-data-pill-open:opacity-100 active:cursor-grabbing">
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    className="size-7 text-neutral-300 hover:bg-white/10 hover:text-white"
                    aria-label="Sağ panelde aç"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() =>
                      browserRightPanelStore.dockMiniPlayerToPanel(projectId, taskId, browserId)
                    }
                  />
                }
              >
                <PanelRight className="size-3.5" />
              </Tooltip.Trigger>
              <Tooltip.Content side="top">Sağ panelde aç</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    className={cn(
                      'size-7 text-neutral-300 hover:bg-white/10 hover:text-white',
                      session?.pictureInPicture && 'bg-white/15 text-white'
                    )}
                    aria-label="Ayrı pencerede aç"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={toggleExternalPip}
                  />
                }
              >
                <PictureInPicture2 className="size-3.5" />
              </Tooltip.Trigger>
              <Tooltip.Content side="top">Ayrı pencerede aç</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    className="size-7 text-neutral-300 hover:bg-white/10 hover:text-white"
                    aria-label="Yüzen pencereyi kapat"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => browserRightPanelStore.closeMiniPlayer(projectId, taskId)}
                  />
                }
              >
                <X className="size-3.5" />
              </Tooltip.Trigger>
              <Tooltip.Content side="top">Yüzen pencereyi kapat</Tooltip.Content>
            </Tooltip.Root>
          </div>
        </div>

        {RESIZE_HANDLES.map(({ direction, className }) => (
          <div
            key={direction}
            role="presentation"
            data-browser-mini-player-resize={direction}
            className={cn('pointer-events-auto absolute z-[49] touch-none', className)}
            onPointerDown={(event) => beginGesture(event, direction)}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onLostPointerCapture={handleLostCapture}
          />
        ))}
      </section>
    </div>,
    document.body
  );
});
