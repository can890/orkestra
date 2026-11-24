import { isSafeColorValue } from '../widget/widget-srcdoc';

/** MCP Apps style variables and the chat theme token each one follows. */
export const MCP_APP_THEME_SOURCES = {
  '--color-background-primary': 'bg',
  '--color-background-secondary': 'bg1',
  '--color-background-tertiary': 'bg2',
  '--color-text-primary': 'fg',
  '--color-text-secondary': 'fgMuted',
  '--color-text-tertiary': 'fgPassive',
  '--color-text-info': 'link',
  '--color-text-danger': 'fgError',
  '--color-border-primary': 'border',
  '--color-border-secondary': 'bg3',
  '--color-ring-primary': 'link',
} as const;

export type McpAppThemeToken = (typeof MCP_APP_THEME_SOURCES)[keyof typeof MCP_APP_THEME_SOURCES];

/** Keeps only colour-shaped values: nothing else of the host's styling reaches the app. */
export function mcpAppStyleVariables(
  resolved: Partial<Record<McpAppThemeToken, string>>
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(MCP_APP_THEME_SOURCES)) {
    const value = resolved[token as McpAppThemeToken];
    if (isSafeColorValue(value)) variables[name] = value.trim();
  }
  return variables;
}

/** `light` or `dark` from a computed `rgb()`/`rgba()` background colour. */
export function colorSchemeOf(background: string | undefined): 'light' | 'dark' {
  const match = /rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i.exec(
    background ?? ''
  );
  if (!match) return 'dark';
  const [r, g, b] = [match[1], match[2], match[3]].map(Number);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? 'light' : 'dark';
}
