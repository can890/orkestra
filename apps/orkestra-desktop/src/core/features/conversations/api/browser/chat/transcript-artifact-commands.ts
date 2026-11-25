import { encodeResourceUri } from '@orkestra/core/primitives/path/api';
import type { ChatCommands } from '@core/features/conversations/api/browser/chat/chat-transcript';
import { getFilesClient } from '@core/features/files/api/browser/client';
import {
  asProvisioned,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { workspaceRegistry } from '@core/features/workspaces/api/browser/stores/workspace-registry';
import {
  absoluteRuntimePath,
  hostFileRefFromNativePath,
  hostPathFromNative,
  nativePathFromHost,
} from '@core/primitives/desktop-runtime/api';

const MAX_PREVIEW_BYTES = 512 * 1024 * 1024;

type ArtifactHostRef =
  | { supported: true; ref: ReturnType<typeof hostFileRefFromNativePath>; filePath: string }
  | { supported: false; message: string };

/**
 * Single uri -> host file mapping shared by the resolver and the existence probe, so the two can
 * never disagree about which file an artifact points at.
 */
function resolveArtifactHostRef(
  context: { projectId: string; taskId: string },
  uri: string
): ArtifactHostRef {
  const task = asProvisioned(getTaskStore(context.projectId, context.taskId));
  const workspace = task ? workspaceRegistry.get(task.workspaceId) : undefined;
  if (!workspace) throw new Error('Çalışma alanına bağlanılamadı.');
  let filePath = uri;
  if (filePath.startsWith('file:')) {
    const url = new URL(filePath);
    if (url.hostname && url.hostname !== 'localhost')
      return { supported: false, message: 'Dosya adresi desteklenmiyor.' };
    filePath = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  } else if (filePath.startsWith('sandbox:')) {
    filePath = filePath.slice('sandbox:'.length);
  } else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(filePath) && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return { supported: false, message: 'Bu çıktı adresinin önizlemesi desteklenmiyor.' };
  }
  const path = absoluteRuntimePath(hostPathFromNative(workspace.path), filePath);
  return {
    supported: true,
    ref: hostFileRefFromNativePath(nativePathFromHost(path), workspace.sshConnectionId),
    filePath,
  };
}

/**
 * Whether an artifact's path exists on the conversation's host. A failed call (host unreachable)
 * rejects instead of answering false, so the transcript falls back to showing the card.
 */
export function createTranscriptArtifactExists(context: {
  projectId: string;
  taskId: string;
}): NonNullable<ChatCommands['artifactExists']> {
  return async (artifact, options) => {
    const target = resolveArtifactHostRef(context, artifact.uri);
    if (!target.supported) return false;
    const client = await getFilesClient();
    const result = await client.fs.exists({ uri: encodeResourceUri(target.ref) }, options);
    if (result.success) return result.data.exists;
    // A definitive "not found" is an answer; anything else says nothing about the file.
    if (result.error.type === 'not-found') return false;
    throw new Error('Dosyanın varlığı doğrulanamadı.');
  };
}

/** Resolve on the conversation's host, including absolute paths outside its checkout. */
export function createTranscriptArtifactResolver(context: {
  projectId: string;
  taskId: string;
}): NonNullable<ChatCommands['resolveArtifact']> {
  return async (artifact, options) => {
    const target = resolveArtifactHostRef(context, artifact.uri);
    if (!target.supported) throw new Error(target.message);
    const { ref, filePath } = target;
    const client = await getFilesClient();
    const result = await client.fs.readBytes(
      {
        uri: encodeResourceUri(ref),
        options: { maxBytes: MAX_PREVIEW_BYTES, stream: true },
      },
      { signal: options?.signal }
    );
    if (!result.success)
      throw new Error(
        result.error.type === 'not-found'
          ? 'Dosya bulunamadı.'
          : 'Çıktı okunamadı. Dosyanın varlığını ve makine bağlantısını kontrol et.'
      );
    if (result.data.meta.truncated) {
      result.data.cancel();
      throw new Error(
        result.data.meta.totalSize > MAX_PREVIEW_BYTES
          ? 'Bu dosya 512 MB önizleme sınırını aşıyor.'
          : 'Uzak makinenin Orkestra sürümü bu büyüklükteki dosyaları desteklemiyor.'
      );
    }
    const cancel = () => result.data.cancel();
    if (options?.signal?.aborted) {
      cancel();
      throw new Error('Önizleme iptal edildi.');
    }
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const parts: ArrayBuffer[] = [];
    try {
      for await (const bytes of result.data.chunks()) {
        const part = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(part).set(bytes);
        parts.push(part);
      }
    } catch (error) {
      result.data.cancel();
      throw error;
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
    }
    if (options?.signal?.aborted) throw new Error('Önizleme iptal edildi.');
    const mimeTypes: Record<string, string> = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      ogv: 'video/ogg',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
      flac: 'audio/flac',
    };
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    const mimeType =
      result.data.meta.mimeType === 'application/octet-stream'
        ? (mimeTypes[extension] ?? result.data.meta.mimeType)
        : result.data.meta.mimeType;
    const url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
    return { url, dispose: () => URL.revokeObjectURL(url) };
  };
}

/**
 * `orkestra-media://` stream URL for video, audio and PDF outputs: nothing is buffered in the
 * renderer, there is no size limit and seeking uses Range requests. `dispose` releases the token.
 */
export function createTranscriptArtifactMediaUrl(context: {
  projectId: string;
  taskId: string;
}): NonNullable<ChatCommands['mediaUrlForArtifact']> {
  return async (artifact, options) => {
    const target = resolveArtifactHostRef(context, artifact.uri);
    if (!target.supported) throw new Error(target.message);
    const client = await getFilesClient();
    const result = await client.media.open(
      { uri: encodeResourceUri(target.ref) },
      { signal: options?.signal }
    );
    if (!result.success) throw new Error(result.error.message);
    const { token, url, size } = result.data;
    return {
      url,
      size,
      dispose: () => {
        void client.media.release({ token }).catch(() => undefined);
      },
    };
  };
}

// Copying gigabytes from a remote machine can take minutes.
const SAVE_COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Streams the output to a user-picked location in the main process. Resolves the saved path, or
 * `undefined` when the user cancels the dialog.
 */
export function createTranscriptArtifactSaver(context: {
  projectId: string;
  taskId: string;
}): (
  artifact: Parameters<NonNullable<ChatCommands['saveArtifact']>>[0]
) => Promise<string | undefined> {
  return async (artifact) => {
    const target = resolveArtifactHostRef(context, artifact.uri);
    if (!target.supported) throw new Error(target.message);
    const client = await getFilesClient();
    const result = await client.media.saveCopy(
      { uri: encodeResourceUri(target.ref) },
      { timeoutMs: SAVE_COPY_TIMEOUT_MS }
    );
    if (!result.success) throw new Error(result.error.message);
    return result.data.path;
  };
}
