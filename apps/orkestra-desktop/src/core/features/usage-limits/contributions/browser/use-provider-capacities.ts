import type { HostRef } from '@orkestra/core/primitives/host/api';
import { useMemo } from 'react';
import {
  evaluateProviderCapacities,
  type ProviderCapacities,
} from '@core/features/usage-limits/api/usage-capacity';
import { INDICATOR_USAGE_PROVIDERS } from '@core/features/usage-limits/api/usage-limits';
import {
  useMinuteClock,
  useUsageLimits,
} from '@core/features/usage-limits/browser/use-usage-limits';

/**
 * Abonelik ajanlarının kalan kapasitesi (göstergeyle aynı önbellek ve kurallar). Diğer
 * özellikler (ör. sohbet devri) kullanım sorgusunu kendileri kurmadan bu kancayı kullanır.
 * `enabled` false iken ağa çıkılmaz; kapasite boş döner (hepsi "unknown").
 */
export function useProviderCapacities(
  host: HostRef,
  options: { enabled?: boolean } = {}
): { capacities: ProviderCapacities; now: number } {
  const now = useMinuteClock();
  const { snapshot } = useUsageLimits(host, INDICATOR_USAGE_PROVIDERS, options);
  const capacities = useMemo(() => evaluateProviderCapacities(snapshot, now), [snapshot, now]);
  return { capacities, now };
}
