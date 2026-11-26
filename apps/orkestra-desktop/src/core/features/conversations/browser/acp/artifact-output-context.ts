/** Presentation capability sent privately; never replaces the visible user request. */
export async function withArtifactOutputContext(
  context?: string | Promise<string | undefined>
): Promise<string> {
  const existing = await context;
  return [
    existing,
    [
      'Orkestra can display generated files directly in this conversation.',
      'ONLY embed final deliverables that the user explicitly asked to generate or view: use ![description](<absolute path>) for final images and [filename](<absolute path>) for final videos, audio, or PDFs.',
      'Do NOT embed intermediate files, reference images, contact sheets, character sheets, or existing workspace images that you merely inspected during your work — mention them as plain filenames if needed.',
      'Use the path on the current machine. Only announce an output as ready after successful generation; do not invent a path or link.',
    ].join(' '),
  ]
    .filter(Boolean)
    .join('\n\n');
}
