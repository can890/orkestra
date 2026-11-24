export const USER_BUBBLE_MAX_RATIO = 0.78;

export type MessageVars = {
  cardBorder: number;
  collapsedMaxH: number;
  expandedMaxH: number;
  userCardPadX: number;
  userCardPadY: number;
  attachThumb: number;
  attachGap: number;
  footerH: number;
  userFooterH: number;
};

/** Subset of MessageVars projected into CSS via the VE contract. */
export type MessageStyleVars = {
  userCardPadX: number;
  userCardPadY: number;
  cardBorder: number;
  attachThumb: number;
  attachGap: number;
};

/** Maximum width (px) allowed for a right-aligned T3-style user bubble. */
export function userBubbleMaxWidth(ctxWidth: number): number {
  if (ctxWidth < 320) return Math.max(1, ctxWidth);
  return Math.max(1, Math.min(ctxWidth, Math.floor(ctxWidth * USER_BUBBLE_MAX_RATIO)));
}

/** Available width for block layout inside the user bubble. */
export function userInnerWidth(ctxWidth: number, vars: MessageVars): number {
  return Math.max(1, userBubbleMaxWidth(ctxWidth) - 2 * vars.userCardPadX - 2 * vars.cardBorder);
}

/**
 * Total height consumed by the attachment strip (including the bottom gap that
 * separates it from the text block). Returns 0 when there are no attachments.
 */
export function attachStripHeight(count: number, innerW: number, vars: MessageVars): number {
  if (count <= 0) return 0;
  const { attachThumb: thumb, attachGap: gap } = vars;
  const perRow = Math.max(1, Math.floor((innerW + gap) / (thumb + gap)));
  const rows = Math.ceil(count / perRow);
  return rows * thumb + (rows - 1) * gap + gap;
}
