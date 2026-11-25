/**
 * ACP araç türleri ve Orkestra'nın genişletilmiş araç türü taşıyıcısı.
 *
 * ACP sözleşmesi `tool_call.kind` alanını kapalı bir listeyle sınırlar; SDK
 * (`ClientSideConnection`) bu listede olmayan bir değer taşıyan `tool_call`
 * bildirimini "Invalid params" (-32602) ile tümüyle reddeder. Orkestra'nın
 * kendi türleri (ör. `subagent`) bu yüzden kablo üzerinde `kind: 'other'` olarak
 * gider ve asıl tür `_meta.orkestra.toolKind` alanında taşınır; çözücü
 * (`decodeSessionUpdate`) bu alanı `kind`'dan önce okur.
 */

/** ACP SDK'nın `ToolKind` birliği (sdk 1.x, `zToolKind`). */
export const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

/** ACP SDK'nın `ToolCallStatus` birliği (sdk 1.x, `zToolCallStatus`). */
export const ACP_TOOL_CALL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

/** `_meta` altında Orkestra'ya ait alanların anahtarı. */
export const ORKESTRA_META_KEY = 'orkestra';

/**
 * Güncellemenin `_meta.orkestra.toolKind` alanında taşıdığı genişletilmiş araç
 * türü; yoksa ya da geçersizse `undefined`.
 */
export function readExtendedToolKind(update: unknown): string | undefined {
  if (!update || typeof update !== 'object') return undefined;
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const orkestra = (meta as Record<string, unknown>)[ORKESTRA_META_KEY];
  if (!orkestra || typeof orkestra !== 'object' || Array.isArray(orkestra)) return undefined;
  const toolKind = (orkestra as { toolKind?: unknown }).toolKind;
  return typeof toolKind === 'string' && toolKind.trim() ? toolKind : undefined;
}

/**
 * Güncelleme bir arka plan görevini mi anlatıyor? Sağlayıcı bağdaştırıcısı, arka plana alınmış bir
 * aracın satırına `_meta.orkestra.backgroundTask` ekler (ör. Antigravity `run_command`); ACP'nin
 * kapalı `kind`/`status` kümeleri bu bilgiyi taşıyamaz.
 */
export function readBackgroundTask(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false;
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const orkestra = (meta as Record<string, unknown>)[ORKESTRA_META_KEY];
  if (!orkestra || typeof orkestra !== 'object' || Array.isArray(orkestra)) return false;
  const task = (orkestra as { backgroundTask?: unknown }).backgroundTask;
  return Boolean(task) && typeof task === 'object' && !Array.isArray(task);
}
