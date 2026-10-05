/** Presentation capability sent privately; never replaces the visible user request. */
export async function withArtifactOutputContext(
  context?: string | Promise<string | undefined>
): Promise<string> {
  const existing = await context;
  return [
    existing,
    [
      'Orkestra can display generated files directly in this conversation.',
      'When you create an image, video, audio, PDF, or other deliverable, include its actual file path or output URL in your final response.',
      'Use ![description](<absolute path>) for images and [filename](<absolute path>) for other files, or return native image/resource content when available.',
      'Use the path on the current machine. Only announce an output as ready after successful generation; do not invent a path or link.',
    ].join(' '),
  ]
    .filter(Boolean)
    .join('\n\n');
}
