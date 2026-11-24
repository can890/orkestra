import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

const DOT_COUNT = 9;
const dotStaticOpacity = [0.96, 0.72, 0.48, 0.72, 0.48, 0.32, 0.48, 0.32, 0.24];

/**
 * Nokta dalgasının bir çevrimdeki görünümü (konum 0..1 → opaklık, ölçek). Eskiden her nokta bu
 * eğriyi sürekli bir CSS animasyonuyla izliyordu; şimdi eğri DOT_COUNT dilime örneklenir ve faz,
 * ortak düşük frekanslı zamanlayıcıdan `data-phase` özniteliğiyle gelir (bkz. animation-ticker).
 */
function dotWave(position: number): { opacity: number; scale: number } {
  const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
  if (position <= 0.35) {
    const t = position / 0.35;
    return { opacity: lerp(0.3, 1, t), scale: lerp(0.8, 1, t) };
  }
  if (position <= 0.68) {
    const t = (position - 0.35) / 0.33;
    return { opacity: lerp(1, 0.4, t), scale: lerp(1, 0.89, t) };
  }
  const t = (position - 0.68) / 0.32;
  return { opacity: lerp(0.4, 0.3, t), scale: lerp(0.89, 0.8, t) };
}

export const root = style({
  '@layer': {
    recipes: {
      display: 'inline-flex',
      width: 'var(--agent-status-size, 1.5rem)',
      height: 'var(--agent-status-size, 1.5rem)',
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
    },
  },
});

export const icon = style({
  '@layer': {
    recipes: {
      display: 'block',
      width: '100%',
      height: '100%',
      overflow: 'visible',
    },
  },
});

export const workingIcon = style({
  '@layer': {
    recipes: {
      color: vars.foregroundMuted,
    },
  },
});

export const dot = Array.from({ length: DOT_COUNT }, (_, index) =>
  style({
    '@layer': {
      recipes: {
        fill: 'currentColor',
        // Faz gelmeden önce (ve hareket azaltma açıkken) sabit desen.
        opacity: dotStaticOpacity[index]?.toString() ?? '0.48',
        transform: 'scale(0.9)',
        transformBox: 'fill-box',
        transformOrigin: 'center',
        selectors: Object.fromEntries(
          Array.from({ length: DOT_COUNT }, (_, phase) => {
            // Nokta `index`, dalganın başından `index` dilim geride gelir.
            const slot = (((phase - index) % DOT_COUNT) + DOT_COUNT) % DOT_COUNT;
            const { opacity, scale } = dotWave((slot + 0.5) / DOT_COUNT);
            return [
              `${workingIcon}[data-phase="${phase}"] &`,
              { opacity: opacity.toFixed(2), transform: `scale(${scale.toFixed(2)})` },
            ];
          })
        ),
      },
    },
  })
);

export const warningShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundWarning,
      stroke: vars.foregroundWarning,
    },
  },
});

export const successShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundSuccess,
      stroke: vars.foregroundSuccess,
    },
  },
});

export const errorShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundError,
      stroke: vars.foregroundError,
    },
  },
});

export const errorMark = style({
  '@layer': {
    recipes: {
      fill: vars.foregroundError,
      stroke: vars.foregroundError,
      strokeLinecap: 'round',
    },
  },
});
