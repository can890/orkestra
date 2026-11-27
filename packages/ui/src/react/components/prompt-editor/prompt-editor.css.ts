import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';
// Colocated chip-class styles — global selectors for TipTap-serialized HTML.
import './chip-classes.css';

export const editorWrapper = style({
  position: 'relative',
  width: '100%',
});

export const editorContent = style({
  width: '100%',
  outline: 'none',
});

export const editorPlaceholder = style({
  pointerEvents: 'none',
  position: 'absolute',
  top: 0,
  left: 0,
  // One line only: in a narrow pane the hint truncates instead of wrapping out of the editor.
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textSm,
  lineHeight: 1.4,
  userSelect: 'none',
  color: vars.foregroundPassive,
});

export const editorGhostSuggestion = style({
  pointerEvents: 'none',
  position: 'absolute',
  top: 0,
  left: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  maxWidth: '100%',
  fontSize: tokenVars.textSm,
  lineHeight: 1.4,
  userSelect: 'none',
  color: vars.foregroundPassive,
  opacity: 0.78,
});

export const editorGhostText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const editorGhostTabBadge = style({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 0.3125rem',
  height: '1.05rem',
  borderRadius: '0.25rem',
  border: `1px solid ${vars.border}`,
  fontSize: '0.625rem',
  fontWeight: 500,
  lineHeight: 1,
  letterSpacing: '0.02em',
  color: vars.foregroundPassive,
  opacity: 0.85,
});

// These classes are assigned via TipTap editorProps.attributes.class
export const promptEditorContentClass = style({
  outline: 'none',
  fontSize: tokenVars.textSm,
  lineHeight: 1.4,
  color: vars.foreground,
  minHeight: '1.25rem',
});

export const noTypedText = style({});
globalStyle(`${noTypedText} .node-mention:has([data-mention-kind="image"])`, {
  display: 'none',
});
