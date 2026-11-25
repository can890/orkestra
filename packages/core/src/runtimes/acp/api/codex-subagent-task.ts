const CODEX_OPAQUE_TASK = /^gAAAAA[A-Za-z0-9_-]{40,}={0,2}(?:…|\.\.\.)?$/;

export const CODEX_TASK_UNAVAILABLE = 'Codex bu ajanın talimat metnini paylaşmadı.';

export function isOpaqueCodexTask(value: unknown): boolean {
  return typeof value === 'string' && CODEX_OPAQUE_TASK.test(value.trim());
}

export function readableCodexTask(...candidates: unknown[]): string | undefined {
  return candidates.find(
    (value): value is string =>
      typeof value === 'string' && Boolean(value.trim()) && !isOpaqueCodexTask(value)
  );
}
