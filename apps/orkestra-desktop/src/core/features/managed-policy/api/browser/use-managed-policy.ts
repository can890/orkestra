import type { ManagedPolicySummary } from '@orkestra/shared/managed-policy';
import { isLockedSettingPath } from '@orkestra/shared/managed-policy';
import { useEffect, useState } from 'react';
import { getManagedPolicyClient } from './client';

// Politika süreç ömrü boyunca değişmediğinden tek bir istek yeterlidir; tüm satırlar aynı
// sonucu paylaşır.
let summaryPromise: Promise<ManagedPolicySummary | null> | null = null;
let cached: ManagedPolicySummary | null | undefined;

function loadSummary(): Promise<ManagedPolicySummary | null> {
  summaryPromise ??= getManagedPolicyClient()
    .then((client) => client.getSummary())
    .then((summary) => {
      cached = summary;
      return summary;
    })
    .catch(() => {
      // Bağlantı hazır değilse sonraki bileşen yeniden denesin.
      summaryPromise = null;
      return null;
    });
  return summaryPromise;
}

/** Yüklenmiş politika özeti; politika yoksa ya da henüz yüklenmediyse `null`. */
export function useManagedPolicy(): ManagedPolicySummary | null {
  const [summary, setSummary] = useState<ManagedPolicySummary | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    void loadSummary().then((value) => {
      if (alive) setSummary(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return summary;
}

/** Ayar yolu politikayla kilitliyse kuruluş adı; değilse `null`. */
export function useManagedSettingLock(path: string | undefined): string | null {
  const summary = useManagedPolicy();
  if (!summary || !path) return null;
  return isLockedSettingPath(summary.lockedSettings, path) ? summary.organization : null;
}
