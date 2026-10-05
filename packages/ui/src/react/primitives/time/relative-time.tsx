import {
  type FormatDistanceToken,
  formatDistanceStrict,
  formatDistanceToNowStrict,
  type Locale,
} from 'date-fns';
import { tr } from 'date-fns/locale/tr';
import * as React from 'react';
import { parseTimestamp } from './parse-timestamp';
import * as styles from './time.css';

/** Label shown instead of a distance for timestamps under a minute old. */
const RELATIVE_TIME_NOW_LABEL = 'şimdi';

/** Turkish short units for the compact form ("5dk", "3sa", "2g"). */
const COMPACT_UNITS: Partial<Record<FormatDistanceToken, string>> = {
  xSeconds: 'sn',
  xMinutes: 'dk',
  xHours: 'sa',
  xDays: 'g',
  xWeeks: 'hf',
  xMonths: 'ay',
  xYears: 'yıl',
};

/** Minimal date-fns locale that renders strict distances as `<count><unit>`. */
const compactLocale: Pick<Locale, 'formatDistance'> = {
  formatDistance: (token, count) => `${count}${COMPACT_UNITS[token] ?? ''}`,
};

export interface RelativeTimeProps {
  value: string | number | Date;
  className?: string;
  /** Renders an abbreviated form (e.g. "3g", "5ay") instead of the full distance. */
  compact?: boolean;
  /** In compact mode, appends a muted "önce" suffix (skipped while showing "şimdi"). */
  ago?: boolean;
}

/** Abbreviated Turkish distance; timestamps under a minute old show "şimdi". */
export function toCompactLabel(date: Date, now: number = Date.now()): string {
  if (now - date.getTime() < 60_000) return RELATIVE_TIME_NOW_LABEL;
  return formatDistanceStrict(date, now, { roundingMethod: 'floor', locale: compactLocale });
}

/**
 * RelativeTime — renders a timestamp as a Turkish distance from now ("3 dakika önce"),
 * re-rendering on a 60-second interval so displayed distances stay current.
 * Unparseable input renders "—".
 */
export function RelativeTime({ value, className, compact, ago }: RelativeTimeProps) {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const date = React.useMemo(() => parseTimestamp(value), [value]);
  if (!date) {
    return <span className={className}>—</span>;
  }

  if (compact) {
    const short = toCompactLabel(date);
    const showAgo = ago && short !== RELATIVE_TIME_NOW_LABEL;

    return (
      <time className={className} dateTime={date.toISOString()}>
        {short}
        {showAgo && <span className={styles.agoSuffix}> önce</span>}
      </time>
    );
  }

  return (
    <time className={className} dateTime={date.toISOString()}>
      {formatDistanceToNowStrict(date, { addSuffix: true, locale: tr })}
    </time>
  );
}
