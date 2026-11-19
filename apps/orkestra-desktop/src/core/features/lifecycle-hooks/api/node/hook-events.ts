import type { HookDefinition, HookEventName, LifecycleHooksConfig } from '../hook-config';

/**
 * Bir kanca olayı. `projectId`/`taskId`/`conversationId` denetimli kimliklerdir ve süreç
 * ortamına konabilir; `data` ise kullanıcı/ajan içeriği taşıyabilir ve YALNIZCA stdin
 * JSON'una girer (hiçbir zaman env'e, argv'ye ya da komut metnine).
 */
export type LifecycleHookEvent = Readonly<{
  name: HookEventName;
  projectId: string;
  taskId: string;
  conversationId?: string;
  occurredAt: number;
  data: Readonly<Record<string, string | number | boolean | null | undefined>>;
}>;

/** Olay için çalışması gereken kancalar: duraklatılmamış, etkin, olay türü ve proje süzgeci uyan. */
export function matchHooks(
  config: LifecycleHooksConfig,
  event: Pick<LifecycleHookEvent, 'name' | 'projectId'>
): HookDefinition[] {
  if (config.paused) return [];
  return config.hooks.filter(
    (hook) =>
      hook.enabled &&
      hook.event === event.name &&
      (hook.projectIds.length === 0 || hook.projectIds.includes(event.projectId))
  );
}
