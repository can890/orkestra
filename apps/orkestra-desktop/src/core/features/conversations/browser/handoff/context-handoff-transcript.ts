/**
 * Bağlam devrinde kaynak konuşmanın tam dökümünü yeni ajanın okuyabileceği bir dosyaya yazar.
 *
 * Konum: ajanın çalıştığı ana makinede (yerel ya da SSH) kullanıcının ev dizini altında
 * `~/.orkestra/handoffs/<yeni sohbet kimliği>.md`. Böylece dosya projenin git çalışma ağacını
 * kirletmez ve aynı makinedeki ajan doğrudan okuyabilir. SSH ana makinesinde dosya, o makinenin
 * dosya çalışma zamanı üzerinden yazılır.
 */
import {
  contextHandoffTranscriptDir,
  contextHandoffTranscriptFileName,
  fitTranscript,
  type TranscriptLocation,
} from '@core/features/conversations/api/context-handoff-package';

export type FsResult = { success: true } | { success: false; error: { type?: string } | unknown };

export type TranscriptFilesDeps = {
  /** Ana makinenin ev dizini (yerel için `connectionId` yok). */
  getHomeDir(connectionId: string | undefined): Promise<string>;
  createDirectory(input: { path: string; connectionId: string | undefined }): Promise<FsResult>;
  writeText(input: {
    path: string;
    connectionId: string | undefined;
    content: string;
  }): Promise<FsResult>;
};

function errorType(result: FsResult): string | undefined {
  if (result.success) return undefined;
  const error = result.error;
  return error && typeof error === 'object' && 'type' in error
    ? String((error as { type?: unknown }).type)
    : undefined;
}

function describeError(result: FsResult): string {
  if (result.success) return '';
  const error = result.error as { type?: unknown; message?: unknown } | undefined;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) return error.message;
    if (typeof error.type === 'string') return error.type;
  }
  return String(error);
}

function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir}${separator}${name}`;
}

/**
 * Dökümü yazar ve yeni ajana bildirilecek konumu döndürür. Hiçbir hata fırlatmaz: yazılamazsa
 * nedeniyle birlikte `unavailable` döner (devir yine yapılır, yeni ajana söylenir).
 */
export async function writeContextHandoffTranscript(
  input: { connectionId: string | undefined; newConversationId: string; markdown: string },
  deps: TranscriptFilesDeps
): Promise<TranscriptLocation> {
  try {
    const home = (await deps.getHomeDir(input.connectionId)).trim();
    if (!home) return { kind: 'unavailable', reason: 'ev dizini bulunamadı' };
    const dir = contextHandoffTranscriptDir(home);
    const parent = dir.slice(0, Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')));
    for (const path of [parent, dir]) {
      const created = await deps.createDirectory({ path, connectionId: input.connectionId });
      if (!created.success && errorType(created) !== 'already-exists') {
        return { kind: 'unavailable', reason: `klasör oluşturulamadı: ${describeError(created)}` };
      }
    }
    const path = joinPath(dir, contextHandoffTranscriptFileName(input.newConversationId));
    const fitted = fitTranscript(input.markdown);
    const written = await deps.writeText({
      path,
      connectionId: input.connectionId,
      content: fitted.text,
    });
    if (!written.success) {
      return { kind: 'unavailable', reason: `dosya yazılamadı: ${describeError(written)}` };
    }
    return {
      kind: 'written',
      path,
      hostLabel: input.connectionId
        ? 'SSH ana makinesinde, çalıştığın makinede'
        : 'çalıştığın makinede',
      truncated: fitted.truncated,
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
