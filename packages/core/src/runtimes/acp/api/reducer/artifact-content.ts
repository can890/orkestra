import type { TranscriptArtifact } from '#primitives/acp-transcript/api/artifacts';

/** Only structured output fields are traversed; inputs are never treated as produced files. */
export function extractArtifacts(value: unknown): TranscriptArtifact[] {
  const artifacts: TranscriptArtifact[] = [];
  const seen = new Set<string>();
  const add = (uri: string, name?: string, mimeType?: string) => {
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    artifacts.push({
      uri,
      name:
        name ||
        (uri.startsWith('data:') ? 'Generated media' : uri.split(/[\\/]/).pop()) ||
        'Output',
      ...(mimeType ? { mimeType } : {}),
    });
  };
  const visit = (current: unknown, depth: number) => {
    if (depth > 8 || !current) return;
    if (typeof current === 'string') {
      for (const match of current.matchAll(
        /(?:^|[\s"'`])((?:\/|[A-Za-z]:[\\/])[^\s"'`<>]*\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|pdf))(?=$|[\s"'`.,;)])/gim
      ))
        add(match[1]);
      for (const match of current.matchAll(/!?\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
        const uri = match[2] ?? match[3];
        if (
          /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|pdf)(?:[?#].*)?$/i.test(
            uri
          )
        )
          add(uri, match[1]);
      }
      if (current.length < 1024 * 1024 && /^[\s]*[[{]/.test(current)) {
        try {
          visit(JSON.parse(current), depth + 1);
        } catch {
          /* Ordinary text is not structured output. */
        }
      }
      return;
    }
    if (typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1);
      return;
    }
    const block = current as Record<string, unknown>;
    const name = typeof block.name === 'string' ? block.name : undefined;
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : undefined;
    if (
      (block.type === 'image' || block.type === 'audio') &&
      typeof block.data === 'string' &&
      mimeType
    ) {
      add(`data:${mimeType};base64,${block.data}`, name, mimeType);
    }
    if (block.type === 'resource_link' && typeof block.uri === 'string') {
      add(block.uri, name, mimeType);
    }
    if (typeof block.blob === 'string' && mimeType) {
      add(`data:${mimeType};base64,${block.blob}`, name, mimeType);
    }
    if (typeof block.url === 'string' && mimeType && /^(?:image|video|audio)\//.test(mimeType))
      add(block.url, name, mimeType);
    for (const key of [
      'image_url',
      'image_path',
      'video_url',
      'audio_url',
      'output_file',
      'output_path',
      'file_path',
      'filePath',
    ]) {
      if (typeof block[key] === 'string') add(block[key], name, mimeType);
    }
    if (block.type === 'text') visit(block.text, depth + 1);
    for (const key of [
      'content',
      'resource',
      'result',
      'structuredContent',
      'images',
      'artifacts',
      'output_hint',
    ]) {
      visit(block[key], depth + 1);
    }
  };
  visit(value, 0);
  return artifacts;
}
