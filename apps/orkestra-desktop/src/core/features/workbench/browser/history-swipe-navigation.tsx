import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyHistoryEntry } from '@core/features/workbench/browser/nav-buttons';
import { getNavigationHistory } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';

const SWIPE_TRIGGER_DISTANCE = 120;
const SWIPE_AXIS_LOCK_DISTANCE = 10;
const SWIPE_HORIZONTAL_DOMINANCE = 2;
const SWIPE_IDLE_RESET_MS = 180;

type SwipeDirection = 'back' | 'forward';

function canScrollHorizontally(path: readonly EventTarget[], deltaX: number): boolean {
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const { overflowX } = getComputedStyle(node);
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
    const canScroll =
      deltaX < 0
        ? node.scrollLeft > 0
        : node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    if (canScroll) return true;
  }
  return false;
}

/**
 * macOS trackpad üzerinde iki parmakla sola/sağa kaydırarak görev ve görünümler arasında
 * geri/ileri gezinme sağlar (T3 Code HistorySwipeNavigation uyarlaması).
 */
export function HistorySwipeNavigation() {
  const [indicator, setIndicator] = useState<{
    direction: SwipeDirection;
    progress: number;
  } | null>(null);

  useEffect(() => {
    let locked: 'none' | 'ignored' | SwipeDirection = 'none';
    let sumX = 0;
    let sumY = 0;
    let distance = 0;
    let triggered = false;
    let idleTimer: number | undefined;

    const reset = () => {
      locked = 'none';
      sumX = 0;
      sumY = 0;
      distance = 0;
      triggered = false;
      setIndicator(null);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (Math.abs(event.deltaX) < 0.5 && Math.abs(event.deltaY) < 0.5) return;

      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(reset, SWIPE_IDLE_RESET_MS);

      if (locked === 'ignored' || triggered) return;

      const path = event.composedPath();
      if (locked === 'none') {
        sumX += event.deltaX;
        sumY += event.deltaY;
        if (Math.hypot(sumX, sumY) < SWIPE_AXIS_LOCK_DISTANCE) return;

        if (
          Math.abs(sumX) <= Math.abs(sumY) * SWIPE_HORIZONTAL_DOMINANCE ||
          path.some((node) => node instanceof Element && node.matches('[role="dialog"]')) ||
          canScrollHorizontally(path, sumX)
        ) {
          locked = 'ignored';
          return;
        }

        const direction: SwipeDirection = sumX < 0 ? 'back' : 'forward';
        const history = getNavigationHistory();
        const canNav = direction === 'back' ? history.canGoBack : history.canGoForward;
        if (!canNav) {
          locked = 'ignored';
          return;
        }
        locked = direction;
        distance = Math.abs(sumX);
      } else {
        const step = locked === 'back' ? -event.deltaX : event.deltaX;
        distance = Math.max(0, distance + step);
      }

      const progress = Math.min(1, distance / SWIPE_TRIGGER_DISTANCE);
      setIndicator({ direction: locked, progress });

      if (progress >= 1 && !triggered) {
        triggered = true;
        const history = getNavigationHistory();
        if (locked === 'back' && history.canGoBack) {
          history.back(applyHistoryEntry);
        } else if (locked === 'forward' && history.canGoForward) {
          history.forward(applyHistoryEntry);
        }
        window.setTimeout(reset, 160);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.clearTimeout(idleTimer);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  if (!indicator) return null;

  const isBack = indicator.direction === 'back';
  const ready = indicator.progress >= 0.85;

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none fixed top-1/2 z-[180] -translate-y-1/2 transition-transform duration-75',
        isBack ? 'left-4' : 'right-4'
      )}
      style={{
        opacity: Math.max(0.25, indicator.progress),
        transform: `translateY(-50%) scale(${0.85 + indicator.progress * 0.2})`,
      }}
    >
      <div
        className={cn(
          'flex size-10 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-colors',
          ready
            ? 'border-foreground/30 bg-foreground text-background'
            : 'border-border-1 bg-background-2/90 text-foreground'
        )}
      >
        {isBack ? <ArrowLeft className="size-4" /> : <ArrowRight className="size-4" />}
      </div>
    </div>
  );
}
