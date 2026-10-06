/**
 * Hidden prompt context travels to the agent as its own tagged text block. Providers that replay
 * history on session load echo every prompt block back as a user message, so the tag lets the
 * decoder drop the private part and keep only what the user actually typed.
 */
const OPEN_TAG = '<orkestra_context>';
const CLOSE_TAG = '</orkestra_context>';
const TAGGED_CONTEXT = /<orkestra_context>[\s\S]*?<\/orkestra_context>/g;

/**
 * Untagged artifact-output instructions sent before tagging existed. Grok session histories
 * still replay them; the paragraph is always the last part of its hidden block.
 */
const LEGACY_ARTIFACT_CONTEXT =
  /(?:^|\n\n)Orkestra can display generated files directly in this conversation\.[^\n]*$/;

export function wrapHiddenContext(context: string): string {
  return `${OPEN_TAG}\n${context}\n${CLOSE_TAG}`;
}

/** Removes hidden context from an echoed user message; returns the input when none is present. */
export function stripHiddenContext(text: string): string {
  const stripped = text.replace(TAGGED_CONTEXT, '').replace(LEGACY_ARTIFACT_CONTEXT, '');
  return stripped === text ? text : stripped.trim();
}
