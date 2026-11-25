import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';

export type ArtifactKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export function artifactKind(artifact: TranscriptArtifact): ArtifactKind {
  const mime = artifact.mimeType ?? /^data:([^;,]+)/.exec(artifact.uri)?.[1] ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  const path = artifact.uri.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return 'audio';
  if (/\.pdf$/.test(path)) return 'pdf';
  return 'file';
}

/** Same file whether written as a plain path or a `file:` URI (`file:///a%20b.mp4` → `/a b.mp4`). */
export function artifactPathKey(uri: string): string {
  if (!/^file:/i.test(uri)) return uri;
  const rest = uri.slice('file:'.length).split(/[?#]/)[0] ?? '';
  const path = rest.startsWith('//') ? rest.replace(/^\/\/(?:localhost)?/i, '') : rest;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Card title: the link label, unless it is an address itself (`[file:// link](file:///…)`), in
 * which case the file's own name is shown.
 */
export function artifactDisplayName(uri: string, label?: string): string {
  const trimmed = label?.trim() ?? '';
  const looksLikeAddress =
    /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed) || /^file:/i.test(trimmed) || trimmed === uri;
  if (trimmed && !looksLikeAddress) return trimmed;
  return artifactPathKey(uri).split(/[\\/]/).pop() || trimmed || 'Output';
}

/** Only explicit links and media paths are promoted; ordinary code paths stay in prose. */
export function artifactReferences(text: string): TranscriptArtifact[] {
  const outputs: TranscriptArtifact[] = [];
  const seen = new Set<string>();
  const add = (uri: string, name?: string, image = false, explicitFile = false) => {
    const item = { uri, name: artifactDisplayName(uri, name) };
    if (/^(?:javascript|data:text|data:application\/html):/i.test(uri)) return;
    const key = artifactPathKey(uri);
    if (seen.has(key) || (!image && !explicitFile && artifactKind(item) === 'file')) return;
    seen.add(key);
    outputs.push(item);
  };
  for (const match of text.matchAll(
    /(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g
  )) {
    const uri = match[3] ?? match[4];
    const explicitFile =
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(uri) &&
      /\.[A-Za-z\d]{1,10}$/.test(uri) &&
      !uri.startsWith('//');
    add(uri, match[2], match[1] === '!', explicitFile);
  }
  for (const match of text.matchAll(
    /`([^`\n]+\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|aac|flac|pdf))`/gi
  )) {
    add(match[1]);
  }
  for (const match of text.matchAll(
    /(?:^|[\s"'])((?:\/|[A-Za-z]:[\\/])[^\s"'<>`]*\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|aac|flac|pdf))(?=$|[\s"'.,;:)])/gim
  )) {
    add(match[1]);
  }
  return outputs;
}

export function uniqueArtifacts(artifacts: TranscriptArtifact[]): TranscriptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = artifactPathKey(artifact.uri);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Never use arbitrary provider-supplied schemes as embeddable browser URLs. */
export function safeArtifactUrl(uri: string): string | null {
  if (/^https?:\/\//i.test(uri) || /^blob:/i.test(uri)) return uri;
  if (
    /^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf);base64,/i.test(
      uri
    )
  )
    return uri;
  return null;
}
