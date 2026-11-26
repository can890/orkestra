import { recipe } from '@vanilla-extract/recipes';
import { vars } from '@theme/core/contract/contract.css';

/**
 * Resize handle: a hairline separator whose interactive hit area is widened
 * via a ::after overlay so the visible line can stay 1px.
 *
 * react-resizable-panels renders the separator with `aria-orientation` set to
 * the separator's own orientation (the inverse of the group's): a horizontal
 * group (side-by-side panels) gets a vertical hairline, and vice versa. The
 * base styles cover the vertical hairline; the `[aria-orientation=horizontal]`
 * selectors flip it.
 */
export const handle = recipe({
  base: {
    position: 'relative',
    zIndex: 60,
    display: 'flex',
    width: '1px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'col-resize',
    touchAction: 'none',
    selectors: {
      '&::after': {
        content: '""',
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: '50%',
        width: '12px',
        transform: 'translateX(-50%)',
        cursor: 'col-resize',
      },
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: '50%',
        width: '2px',
        transform: 'translateX(-50%)',
        backgroundColor: 'transparent',
        pointerEvents: 'none',
        transitionProperty: 'background-color',
        transitionDuration: '120ms',
      },
      '&:hover::before, &[data-separator="active"]::before, &[data-resize-handle-active]::before': {
        backgroundColor: `color-mix(in srgb, ${vars.foreground} 35%, transparent)`,
      },
      '&[aria-orientation="horizontal"]': {
        width: '100%',
        height: '1px',
        cursor: 'row-resize',
      },
      '&[aria-orientation="horizontal"]::after': {
        top: '50%',
        bottom: 'auto',
        left: 0,
        width: '100%',
        height: '12px',
        transform: 'translateY(-50%)',
        cursor: 'row-resize',
      },
      '&[aria-orientation="horizontal"]::before': {
        top: '50%',
        bottom: 'auto',
        left: 0,
        width: '100%',
        height: '2px',
        transform: 'translateY(-50%)',
      },
      // Focus lands here transiently during pointer drags (and is restored
      // afterwards), so a visible focus ring would only flash distractingly.
      '&:focus-visible': {
        outline: 'none',
      },
      '&[aria-disabled="true"]': {
        cursor: 'default',
      },
      '&[hidden]': {
        display: 'none',
      },
    },
  },
  variants: {
    variant: {
      /** Always-visible 1px line in the border color. */
      hairline: {
        backgroundColor: vars.border,
      },
      /** Invisible until hovered; used where the layout draws its own divider. */
      ghost: {
        backgroundColor: 'transparent',
        transitionProperty: 'background-color',
        transitionDuration: '150ms',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        selectors: {
          '&:hover': {
            backgroundColor: `color-mix(in srgb, ${vars.border} 80%, transparent)`,
          },
        },
      },
    },
  },
  defaultVariants: {
    variant: 'hairline',
  },
});
