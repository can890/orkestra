/**
 * Prose layout geometry constants.
 *
 * These values are fixed — they are not themeable. They live here, colocated
 * with the prose layout code that owns them.
 */

/** Horizontal indent per nesting level for list items (px). */
export const LIST_INDENT = 16;

/** Horizontal indent per nesting level for blockquotes (px). */
export const BLOCKQUOTE_INDENT = 16;

/** Gap from bullet center-anchor to list item text start (px). */
export const LIST_BULLET_GAP = 12;

/** Gap between the right edge of an ordered-list number and the item text (px). */
export const ORDERED_MARKER_GAP = 6;

/**
 * Geometry of an ordered-list marker column.
 *
 * The number column starts where a bullet glyph's left half would start
 * (`indent - LIST_BULLET_GAP / 2`) and is as wide as the list's widest label,
 * so all numbers of a list right-align (`9.` sits under the `.` of `10.`).
 * Text never starts left of where bullet-list text would, keeping single-digit
 * numbered lists aligned with bullet lists.
 */
export function orderedMarkerGeometry(
  indent: number,
  widestLabelWidth: number
): { markerLeft: number; markerWidth: number; textLeft: number } {
  const markerLeft = indent - LIST_BULLET_GAP / 2;
  // +1px guards against sub-pixel differences between measurement and render.
  const markerWidth = Math.ceil(widestLabelWidth) + 1;
  const textLeft = Math.max(
    indent + LIST_BULLET_GAP,
    markerLeft + markerWidth + ORDERED_MARKER_GAP
  );
  return { markerLeft, markerWidth, textLeft };
}
