import z from 'zod';

export const ORKESTRA_CONFIG_FILE = '.orkestra.json';

export function isOrkestraConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized === ORKESTRA_CONFIG_FILE || normalized.endsWith(`/${ORKESTRA_CONFIG_FILE}`);
}

const preservePatternsSchema = z
  .array(z.string())
  .transform((patterns) => patterns.filter((pattern) => pattern !== ORKESTRA_CONFIG_FILE));

export const orkestraScriptsConfigSchema = z.object({
  prepare: z.string().optional(),
  setup: z.string().optional(),
  run: z.string().optional(),
  teardown: z.string().optional(),
});

/**
 * Stale keys from retired features (e.g. `excludePatterns`) are silently stripped by
 * the non-strict object parse, so old `.orkestra.json` files keep parsing cleanly.
 */
export const orkestraConfigSchema = z.object({
  /** Gitignored files deliberately carried into new worktrees; empty unless configured. */
  preservePatterns: preservePatternsSchema.optional(),
  shellSetup: z.string().optional(),
  scripts: orkestraScriptsConfigSchema.optional(),
});

export type OrkestraConfig = z.infer<typeof orkestraConfigSchema>;
export type OrkestraScriptsConfig = z.infer<typeof orkestraScriptsConfigSchema>;

export type ParseOrkestraConfigResult =
  | { success: true; data: OrkestraConfig }
  | { success: false; data: OrkestraConfig; error: unknown };

export function defaultOrkestraConfig(): OrkestraConfig {
  return orkestraConfigSchema.parse({});
}

export function parseOrkestraConfig(content: string): ParseOrkestraConfigResult {
  try {
    return { success: true, data: orkestraConfigSchema.parse(JSON.parse(content)) };
  } catch (error) {
    return { success: false, data: defaultOrkestraConfig(), error };
  }
}
