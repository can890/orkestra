import { z } from 'zod';
import { permissionModeSchema } from './schema';

/**
 * Bir politikanın yönetebileceği ayarlar: masaüstü uygulama ayarlarındaki nokta yolu
 * (`<ayar anahtarı>.<alan>`) → değer şeması. Liste bilerek dar tutulur: her giriş Ayarlar'da
 * kilitli olarak gösterilen bir satıra karşılık gelir. Masaüstündeki bir test, her yolun gerçek
 * ayar katkısında var olduğunu ve şemanın varsayılanı kabul ettiğini doğrular (sürüklenme koruması).
 */
export const MANAGEABLE_SETTINGS = {
  'tasks.defaultPermissionMode': {
    schema: permissionModeSchema,
    description: 'Default permission mode for new conversations',
  },
  'tasks.autoApproveByDefault': {
    schema: z.boolean(),
    description: 'Auto-approve (skip permission prompts) by default',
  },
  'tasks.autoGenerateName': { schema: z.boolean(), description: 'Auto-generate task names' },
  'tasks.autoTrustWorktrees': {
    schema: z.boolean(),
    description: 'Automatically trust task worktrees',
  },
  'tasks.createBranchAndWorktree': {
    schema: z.boolean(),
    description: 'Create branch and worktree by default',
  },
  'tasks.deleteBranchByDefault': { schema: z.boolean(), description: 'Delete branch by default' },
  'tasks.preserveNameCapitalization': {
    schema: z.boolean(),
    description: 'Preserve task name capitalization',
  },
  'tasks.includeIssueContextByDefault': {
    schema: z.boolean(),
    description: 'Include issue context by default',
  },
  'project.tmuxByDefault': { schema: z.boolean(), description: 'Run agents inside tmux' },
  'project.appendRandomBranchSuffix': {
    schema: z.boolean(),
    description: 'Append a random branch suffix',
  },
  'project.pushOnCreate': { schema: z.boolean(), description: 'Push the branch on task creation' },
  'project.branchNamingMode': {
    schema: z.enum(['static', 'semantic', 'custom']),
    description: 'Branch naming mode',
  },
  'project.autoArchiveMergedPrTasks': {
    schema: z.boolean(),
    description: 'Archive tasks when their pull request merges',
  },
  'updates.autoDownload': { schema: z.boolean(), description: 'Download updates automatically' },
  'computerUse.enabled': { schema: z.boolean(), description: 'Computer use tools for agents' },
  'widgets.enabled': { schema: z.boolean(), description: 'Inline widgets in chat' },
  'chat.workingTurnSubmitMode': {
    schema: z.enum(['queue', 'steer-cancel']),
    description: 'Sending a message while the agent works',
  },
} as const satisfies Record<string, { schema: z.ZodType; description: string }>;

export type ManageableSettingPath = keyof typeof MANAGEABLE_SETTINGS;

export function isManageableSettingPath(path: string): path is ManageableSettingPath {
  return Object.hasOwn(MANAGEABLE_SETTINGS, path);
}

/** `path` kilitli bir yolun kendisi, içinde ya da onu içeren bir yol mu? */
export function isLockedSettingPath(lockedPaths: readonly string[], path: string): boolean {
  return lockedPaths.some(
    (locked) => locked === path || locked.startsWith(`${path}.`) || path.startsWith(`${locked}.`)
  );
}
