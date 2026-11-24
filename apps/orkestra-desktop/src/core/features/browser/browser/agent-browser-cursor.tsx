// Adapted from pingdotgg/t3code (MIT) — visual pointer overlay when an agent drives a page.
import { observer } from 'mobx-react-lite';
import { browserPointerStore } from '@core/features/browser/api/browser/browser-pointer-store';

export const AgentBrowserCursor = observer(function AgentBrowserCursor({
  browserId,
}: {
  browserId: string;
}) {
  const pointer = browserPointerStore.getPointer(browserId);
  if (!pointer) return null;

  return (
    <div
      data-agent-browser-cursor=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 2 }}
    >
      <div
        className="absolute -translate-x-1 -translate-y-1 transition-all duration-150 ease-out"
        style={{ left: pointer.x, top: pointer.y }}
      >
        {pointer.action === 'click' ? (
          <span
            key={pointer.at}
            className="absolute -left-2 -top-2 size-6 animate-ping rounded-full bg-sky-400/45"
          />
        ) : null}
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          aria-hidden="true"
          className="drop-shadow-md"
        >
          <path
            d="M3 2L14 9.5L8.6 10.6L6.4 15.5L3 2Z"
            fill="#0ea5e9"
            stroke="#ffffff"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
});
