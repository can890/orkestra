import { useId } from 'react';

/** Merkezdeki karar vericiye bağlı ajanları gösteren Orkestra simgesi. */
export function OrchestraIcon({ size = 16, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        <defs>
          <linearGradient id={gradientId} x1="2" y1="2" x2="22" y2="22">
            <stop offset="0" stopColor="#f97316" />
            <stop offset="0.5" stopColor="#a855f7" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <g stroke={`url(#${gradientId})`} strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 12 5 5M12 12l7-7M12 12l-7 7M12 12l7 7" />
        </g>
        <circle cx="12" cy="12" r="3.6" fill={`url(#${gradientId})`} />
        <circle cx="4.5" cy="4.5" r="2.2" fill="#f97316" />
        <circle cx="19.5" cy="4.5" r="2.2" fill="#a855f7" />
        <circle cx="4.5" cy="19.5" r="2.2" fill="#22c55e" />
        <circle cx="19.5" cy="19.5" r="2.2" fill="#3b82f6" />
      </svg>
    </span>
  );
}
