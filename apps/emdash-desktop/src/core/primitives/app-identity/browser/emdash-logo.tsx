export const NATURAL_WIDTH = 499;
export const NATURAL_HEIGHT = 70;

export function OrkestraWordmark() {
  return (
    <text
      x={249.5}
      y={56}
      textAnchor="middle"
      fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
      fontSize={65}
      fontWeight={650}
      letterSpacing={-2}
    >
      Orkestra
    </text>
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
      viewBox="0 0 499 70"
      fill={color}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <OrkestraWordmark />
    </svg>
  );
}
