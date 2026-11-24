// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/policy/ManagedPolicy.ts
//
// Yönetilen politikayı açılışta bir kez okur. Uygulanamayan (okunamayan, geçersiz, bu sürümün
// bilmediği anahtarlar taşıyan) bir politikada uygulama başlamaz: "yönetiliyor" görünüp
// uygulanmayan bir politika, hiç politika olmamasından daha kötüdür (fail-closed).
import { pluginRegistry } from '@orkestra/plugins/agents';
import {
  readManagedPolicy,
  type ManagedPolicyLoadResult,
  type ReadManagedPolicyOptions,
} from '@orkestra/shared/managed-policy/node';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';

/** Geçersiz politikada çıkış kodu (sysexits `EX_CONFIG`); systemd birimi bunda yeniden başlatmaz. */
export const MANAGED_POLICY_EXIT_CODE = 78;

export type ManagedPolicyBootDecision =
  | { kind: 'start'; managed: boolean }
  | { kind: 'refuse'; message: string; exitCode: number };

/**
 * Saf karar: politika sonucu → başla / reddet. Başlarsa etkin politika süreç geneline yazılır.
 */
export function applyManagedPolicyLoadResult(
  result: ManagedPolicyLoadResult
): ManagedPolicyBootDecision {
  switch (result.kind) {
    case 'none':
      setActiveManagedPolicy(undefined);
      return { kind: 'start', managed: false };
    case 'loaded':
      setActiveManagedPolicy(result.loaded);
      return { kind: 'start', managed: true };
    case 'error':
      setActiveManagedPolicy(undefined);
      return { kind: 'refuse', message: result.message, exitCode: MANAGED_POLICY_EXIT_CODE };
  }
}

export async function loadManagedPolicyAtStartup(
  options: Pick<ReadManagedPolicyOptions, 'allowPathOverride' | 'env' | 'platform' | 'fs'>
): Promise<ManagedPolicyBootDecision> {
  const result = await readManagedPolicy({
    ...options,
    knownProviderIds: pluginRegistry.getAll().map((plugin) => plugin.metadata.id),
  });
  return applyManagedPolicyLoadResult(result);
}
