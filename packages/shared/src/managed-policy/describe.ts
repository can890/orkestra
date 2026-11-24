// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/cli/policy.ts (describePolicy)
import { PERMISSION_MODE_LABELS, type ManagedPolicySummary } from './schema';
import { MANAGEABLE_SETTINGS, isManageableSettingPath } from './settings-catalog';
import type { ValidatedManagedPolicy } from './validate';

/** Renderer'a giden özet: değerler değil, neyin yönetildiği. */
export function summarizeManagedPolicy(
  policy: ValidatedManagedPolicy,
  meta: { source: string; fingerprint: string }
): ManagedPolicySummary {
  const { document } = policy;
  return {
    organization: document.organization,
    ...(document.supportUrl === undefined ? {} : { supportUrl: document.supportUrl }),
    source: meta.source,
    fingerprint: meta.fingerprint,
    lockedSettings: [...policy.lockedSettings.keys()],
    defaultedSettings: [...policy.defaultSettings.keys()],
    limits: document.limits ?? {},
  };
}

/** Politikanın ne yapacağını, insan okuyacak satırlar olarak açıklar (`policy check`/`show`). */
export function describeManagedPolicyLines(
  policy: ValidatedManagedPolicy,
  meta: { source: string; fingerprint: string }
): string[] {
  const { document } = policy;
  const lines = [
    `Managed by ${document.organization} (${meta.source}, fingerprint ${meta.fingerprint}).`,
  ];
  if (document.supportUrl) lines.push(`Support: ${document.supportUrl}`);

  lines.push('');
  const settings = Object.entries(document.settings ?? {});
  if (settings.length === 0) {
    lines.push('Settings: none managed.');
  } else {
    lines.push('Settings:');
    for (const [path, setting] of settings) {
      const label = isManageableSettingPath(path)
        ? ` — ${MANAGEABLE_SETTINGS[path].description}`
        : '';
      lines.push(
        `  ${path} = ${JSON.stringify(setting.value)} (${setting.locked ? 'locked: users cannot change it' : 'default: users can change it'})${label}`
      );
    }
  }

  lines.push('');
  lines.push('Limits:');
  const limits = document.limits ?? {};
  const limitLines: string[] = [];
  if (limits.maxPermissionMode) {
    limitLines.push(
      `  Broadest permission mode: ${PERMISSION_MODE_LABELS[limits.maxPermissionMode]} (${limits.maxPermissionMode}). Broader modes are lowered to it when a conversation starts and refused when selected.`
    );
  }
  if (limits.providers?.allowed) {
    limitLines.push(
      `  Agents allowed: ${limits.providers.allowed.join(', ')}. Other agents cannot be started and are hidden from pickers.`
    );
  }
  if (limits.providers?.denied) {
    limitLines.push(
      `  Agents denied: ${limits.providers.denied.join(', ')}. They cannot be started and are hidden from pickers.`
    );
  }
  if (limits.remoteAccess === false) {
    limitLines.push('  Remote access (mobile devices): off. Paired devices cannot connect.');
  }
  if (limits.devicePairing === false) {
    limitLines.push('  Device pairing: off. New devices cannot be paired.');
  }
  if (limits.outsideAgents === false) {
    limitLines.push('  Outside-agent MCP server: off.');
  }
  if (limits.updates?.mode === 'off') {
    limitLines.push('  Updates: off. Orkestra does not check for, download or install updates.');
  } else if (limits.updates?.mode === 'auto') {
    limitLines.push('  Updates: normal update flow.');
  }
  lines.push(...(limitLines.length === 0 ? ['  none.'] : limitLines));
  return lines;
}
