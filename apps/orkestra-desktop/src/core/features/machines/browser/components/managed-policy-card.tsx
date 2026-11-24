import { PERMISSION_MODE_LABELS, type ManagedPolicySummary } from '@orkestra/shared/managed-policy';
import { SettingsSection } from '@orkestra/ui/react/patterns';
import { Badge } from '@orkestra/ui/react/primitives';
import { useManagedPolicy } from '@core/features/managed-policy/api/browser/use-managed-policy';

// Ayarlar > Sistem: yöneticinin dağıttığı politikanın neyi uyguladığını salt-okur listeler.
// Politika yoksa kart hiç gösterilmez.

export function managedPolicyLimitLines(summary: ManagedPolicySummary): string[] {
  const limits = summary.limits;
  const lines: string[] = [];
  if (limits.maxPermissionMode) {
    lines.push(`Broadest permission mode: ${PERMISSION_MODE_LABELS[limits.maxPermissionMode]}`);
  }
  if (limits.providers?.allowed)
    lines.push(`Allowed agents: ${limits.providers.allowed.join(', ')}`);
  if (limits.providers?.denied) lines.push(`Blocked agents: ${limits.providers.denied.join(', ')}`);
  if (limits.remoteAccess === false) lines.push('Remote access from other devices is off');
  if (limits.devicePairing === false) lines.push('Pairing new devices is off');
  if (limits.outsideAgents === false) lines.push('The outside-agent MCP server is off');
  if (limits.updates?.mode === 'off') lines.push('Updates are managed by your organization');
  return lines;
}

export function ManagedPolicyCard() {
  const summary = useManagedPolicy();
  if (!summary) return null;
  const limits = managedPolicyLimitLines(summary);
  return (
    <SettingsSection title="Managed policy">
      <div className="space-y-3 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info" variant="outline">
            Managed by your organization
          </Badge>
          <span className="font-medium">{summary.organization}</span>
          {summary.supportUrl ? (
            <a className="underline" href={summary.supportUrl} target="_blank" rel="noreferrer">
              Get help
            </a>
          ) : null}
        </div>
        <PolicyList
          title="Locked settings"
          empty="No settings are locked."
          items={summary.lockedSettings}
        />
        <PolicyList
          title="Organization defaults (you can change these)"
          empty="No defaults are set."
          items={summary.defaultedSettings}
        />
        <PolicyList title="Limits" empty="No limits are enforced." items={limits} />
        <p className="text-xs text-foreground-passive">
          {`Loaded from ${summary.source} (fingerprint ${summary.fingerprint}) when Orkestra started. Restart Orkestra after your administrator changes the policy.`}
        </p>
      </div>
    </SettingsSection>
  );
}

function PolicyList({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <div className="space-y-1">
      <div className="font-medium">{title}</div>
      {items.length === 0 ? (
        <div className="text-foreground-passive">{empty}</div>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">
          {items.map((item) => (
            <li key={item}>
              <code className="text-xs">{item}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
