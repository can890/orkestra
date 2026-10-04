import appIcon from '@/assets/images/emdash/emdash.png';

export const NATURAL_WIDTH = 380;
export const NATURAL_HEIGHT = 70;

export function OrkestraWordmark() {
  return (
    <>
      <image href={appIcon} x={0} y={0} width={70} height={70} />
      <text
        x={86}
        y={54}
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
        fontSize={64}
        fontWeight={650}
        letterSpacing={-2}
      >
        Orkestra
      </text>
    </>
  );
}

export function EmdashLogo({
  className,
  height = NATURAL_HEIGHT,
  color = 'currentColor',
}: {
  className?: string;
  height?: number;
  color?: string;
}) {
  const width = (height / NATURAL_HEIGHT) * NATURAL_WIDTH;

  return (
    <svg
      role="img"
      aria-label="Orkestra"
      width={width}
      height={height}
      viewBox={`0 0 ${NATURAL_WIDTH} ${NATURAL_HEIGHT}`}
      fill={color}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <OrkestraWordmark />
    </svg>
  );
}
