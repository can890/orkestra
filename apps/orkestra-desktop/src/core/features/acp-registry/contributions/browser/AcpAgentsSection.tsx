// Ayarlar > Ajanlar sayfasındaki "ACP ajanları" bölümü: resmî ACP Registry'de arama, kurulum
// planının onayı ve yerel ACP komutu ekleme. Yalnızca yerel host için gösterilir.
import { Alert, Badge, Button, Input, Spinner, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  RegistryInstallPlan,
  RegistrySearchAgent,
  RegistrySearchResult,
} from '../../api/schemas';
import { ACP_REGISTRY_QUERY_KEY, getAcpRegistryClient, unwrapAcp } from '../../browser/client';

const SEARCH_DEBOUNCE_MS = 300;

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
    void queryClient.invalidateQueries({ queryKey: ACP_REGISTRY_QUERY_KEY });
  };
}

export function AcpAgentsSection() {
  const [panel, setPanel] = useState<'registry' | 'local' | null>(null);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">ACP agents</h3>
          <p className="max-w-xl text-xs text-foreground-muted">
            Add any agent from the official ACP Registry or your own local ACP command. They work
            like built-in agents in new conversations. These agents run on this computer only and
            are not available in remote (SSH) workspaces.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={panel === 'registry' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setPanel(panel === 'registry' ? null : 'registry')}
          >
            <Search className="size-3.5" />
            Browse ACP Registry
          </Button>
          <Button
            variant={panel === 'local' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setPanel(panel === 'local' ? null : 'local')}
          >
            <Plus className="size-3.5" />
            Add local ACP command
          </Button>
        </div>
      </div>
      {panel === 'registry' && <RegistryPanel />}
      {panel === 'local' && <LocalCommandForm onDone={() => setPanel(null)} />}
    </section>
  );
}

function formatTime(ms: number | null): string {
  if (ms === null) return 'never';
  return new Date(ms).toLocaleString();
}

function RegistryPanel() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState<RegistryInstallPlan | null>(null);
  const invalidate = useInvalidateAgents();

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const search = useQuery<RegistrySearchResult>({
    queryKey: [...ACP_REGISTRY_QUERY_KEY, 'search', query],
    queryFn: async () => unwrapAcp(await (await getAcpRegistryClient()).search({ query })),
    staleTime: 60_000,
  });
  const refresh = useMutation({
    mutationFn: async () =>
      unwrapAcp(await (await getAcpRegistryClient()).search({ query, refresh: true })),
    onSuccess: () => invalidate(),
    onError: (error: Error) =>
      toast.error('Could not refresh the ACP Registry', { description: error.message }),
  });
  const preview = useMutation({
    mutationFn: async (input: { agentId: string; replacesProviderId?: string }) =>
      unwrapAcp(await (await getAcpRegistryClient()).previewRegistryAgent(input)),
    onSuccess: setPlan,
    onError: (error: Error) =>
      toast.error('Could not prepare the agent', { description: error.message }),
  });

  const result = search.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search the ACP Registry…"
          aria-label="Search the ACP Registry"
        />
        <Button
          variant="secondary"
          icon
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          aria-label="Refresh the ACP Registry"
        >
          <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} />
        </Button>
      </div>
      {result?.offline ? (
        <Alert.Root status="warning">
          Offline: showing the cached ACP Registry from {formatTime(result.fetchedAt)}.
          {result.offlineReason ? ` ${result.offlineReason}` : ''}
        </Alert.Root>
      ) : result?.stale ? (
        <Alert.Root status="warning">
          The cached ACP Registry is out of date. Refresh to load the latest list.
        </Alert.Root>
      ) : null}
      {result && result.platformTarget === null ? (
        <Alert.Root status="warning">
          This computer's platform is not supported by ACP Registry binaries.
        </Alert.Root>
      ) : null}
      {plan ? (
        <InstallPlanCard
          plan={plan}
          onCancel={() => setPlan(null)}
          onInstalled={() => {
            setPlan(null);
            invalidate();
          }}
        />
      ) : null}
      {search.isLoading ? <Spinner size="sm" /> : null}
      {search.error ? (
        <Alert.Root status="destructive">{(search.error as Error).message}</Alert.Root>
      ) : null}
      <div className="flex max-h-[28rem] flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
        {result?.agents.map((agent) => (
          <RegistryRow
            key={agent.id}
            agent={agent}
            busy={preview.isPending && preview.variables?.agentId === agent.id}
            onAdd={() => preview.mutate({ agentId: agent.id })}
            onUpdate={(providerId) =>
              preview.mutate({ agentId: agent.id, replacesProviderId: providerId })
            }
          />
        ))}
        {result && result.agents.length === 0 ? (
          <div className="p-4 text-xs text-foreground-muted">No agents match your search.</div>
        ) : null}
      </div>
      {result ? (
        <p className="text-xs text-foreground-passive">
          Last updated {formatTime(result.fetchedAt)} · Registry agents are third-party code; review
          an agent's source and license before adding it.
        </p>
      ) : null}
    </div>
  );
}

export function RegistryIcon({ agentId, size = 20 }: { agentId: string; size?: number }) {
  const icon = useQuery({
    queryKey: [...ACP_REGISTRY_QUERY_KEY, 'icon', agentId],
    queryFn: async () => unwrapAcp(await (await getAcpRegistryClient()).icon({ agentId })),
    staleTime: Infinity,
  });
  if (!icon.data?.dataUri)
    return <Bot style={{ width: size, height: size }} className="text-foreground-muted" />;
  return <img src={icon.data.dataUri} alt="" width={size} height={size} className="dark:invert" />;
}

function RegistryRow({
  agent,
  busy,
  onAdd,
  onUpdate,
}: {
  agent: RegistrySearchAgent;
  busy: boolean;
  onAdd: () => void;
  onUpdate: (providerId: string) => void;
}) {
  const updateAvailable = agent.added !== null && agent.added.version !== agent.version;
  let action: ReactNode;
  if (agent.builtInProviderId) {
    action = <Badge tone="info">Built in</Badge>;
  } else if (agent.added) {
    action = updateAvailable ? (
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => onUpdate(agent.added!.providerId)}
      >
        {busy ? <Spinner size="sm" /> : null}
        Update to {agent.version}
      </Button>
    ) : (
      <Badge tone="success">Added</Badge>
    );
  } else if (!agent.runnerAvailable) {
    action = <Badge tone="warning">Requires {agent.runner}</Badge>;
  } else {
    action = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onAdd}>
        {busy ? <Spinner size="sm" /> : null}
        Add
      </Button>
    );
  }
  return (
    <div className="flex items-start gap-3 p-3">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
        {agent.hasIcon ? (
          <RegistryIcon agentId={agent.id} />
        ) : (
          <Bot className="size-5 text-foreground-muted" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">{agent.name}</span>
          <span className="text-xs text-foreground-passive">{agent.version}</span>
          <Badge variant="outline">{agent.distribution}</Badge>
          {agent.integrity === 'sha256' ? (
            <Badge variant="outline" tone="success">
              SHA-256
            </Badge>
          ) : null}
        </div>
        <p className="line-clamp-2 text-xs text-foreground-muted">{agent.description}</p>
        <div className="flex flex-wrap gap-3 text-xs text-foreground-passive">
          {agent.authors.length > 0 ? <span>{agent.authors.join(', ')}</span> : null}
          {agent.license ? <span>{agent.license}</span> : null}
          {agent.repository ? (
            <a
              href={agent.repository}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Source
            </a>
          ) : null}
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function InstallPlanCard({
  plan,
  onCancel,
  onInstalled,
}: {
  plan: RegistryInstallPlan;
  onCancel: () => void;
  onInstalled: () => void;
}) {
  const install = useMutation({
    mutationFn: async () =>
      unwrapAcp(
        await (
          await getAcpRegistryClient()
        ).addRegistryAgent({
          agentId: plan.agentId,
          version: plan.version,
          digest: plan.digest,
          ...(plan.replacesProviderId ? { replacesProviderId: plan.replacesProviderId } : {}),
        })
      ),
    onSuccess: (agent) => {
      toast.success(`${agent.name} added`, {
        description:
          'Open it under Agents and run "Check agent" to read its sign-in methods and models.',
      });
      onInstalled();
    },
    onError: (error: Error) =>
      toast.error('Could not add the agent', { description: error.message }),
  });
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-warning bg-background-warning/30 p-3 text-xs">
      <div className="text-sm font-medium text-foreground">
        {plan.replacesProviderId ? 'Update' : 'Add'} {plan.name} {plan.version}?
      </div>
      <p className="text-foreground-muted">
        This downloads and runs third-party code on this computer. Nothing runs until you confirm,
        and the agent itself only starts when you use it or run a check.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-foreground-passive">Distribution</dt>
        <dd className="font-mono">{plan.distribution}</dd>
        {plan.packageSpec ? (
          <>
            <dt className="text-foreground-passive">Package</dt>
            <dd className="font-mono break-all">{plan.packageSpec}</dd>
          </>
        ) : null}
        {plan.archiveUrl ? (
          <>
            <dt className="text-foreground-passive">Download</dt>
            <dd className="font-mono break-all">{plan.archiveUrl}</dd>
            <dt className="text-foreground-passive">SHA-256</dt>
            <dd className="font-mono break-all">
              {plan.sha256 ?? 'Not declared by the registry (HTTPS only)'}
            </dd>
          </>
        ) : null}
        {plan.installCommand ? (
          <>
            <dt className="text-foreground-passive">Install command</dt>
            <dd className="font-mono break-all">{plan.installCommand.join(' ')}</dd>
          </>
        ) : null}
        <dt className="text-foreground-passive">Installed to</dt>
        <dd className="font-mono break-all">{plan.installDir}</dd>
        <dt className="text-foreground-passive">Runs</dt>
        <dd className="font-mono break-all">{plan.launchCommand.join(' ')}</dd>
        {Object.keys(plan.launchEnv).length > 0 ? (
          <>
            <dt className="text-foreground-passive">Environment</dt>
            <dd className="font-mono break-all">
              {Object.entries(plan.launchEnv)
                .map(([key, value]) => `${key}=${value}`)
                .join(' ')}
            </dd>
          </>
        ) : null}
        {plan.license ? (
          <>
            <dt className="text-foreground-passive">License</dt>
            <dd>{plan.license}</dd>
          </>
        ) : null}
      </dl>
      {plan.distribution === 'npx' ? (
        <p className="text-foreground-muted">
          npm runs the package's install scripts during installation.
        </p>
      ) : null}
      <p className="text-foreground-muted">
        Version {plan.version} is pinned. Newer registry versions are only installed when you choose
        Update.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={install.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => install.mutate()}
          disabled={install.isPending}
        >
          {install.isPending ? <Spinner size="sm" /> : null}
          Install and add
        </Button>
      </div>
    </div>
  );
}

type EnvRow = { key: string; value: string };

function LocalCommandForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string[]>(['']);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [cwd, setCwd] = useState('');
  const invalidate = useInvalidateAgents();
  const add = useMutation({
    mutationFn: async () =>
      unwrapAcp(
        await (
          await getAcpRegistryClient()
        ).addLocalAgent({
          name,
          command,
          args: args.filter((arg) => arg.length > 0),
          env: Object.fromEntries(
            env.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value])
          ),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        })
      ),
    onSuccess: (agent) => {
      toast.success(`${agent.name} added`, {
        description: 'Open it under Agents and run "Check agent" to verify the command.',
      });
      invalidate();
      onDone();
    },
    onError: (error: Error) =>
      toast.error('Could not add the command', { description: error.message }),
  });
  const preview = [command.trim(), ...args.filter((arg) => arg.length > 0)].join(' ');
  return (
    <form
      className="flex flex-col gap-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && command.trim()) add.mutate();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-foreground-muted">Display name</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="DeepSeek Harness"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-foreground-muted">Executable name or absolute path</span>
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="dsh"
          className="font-mono"
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-foreground-muted">Arguments (one per row, passed literally)</span>
        {args.map((arg, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={arg}
              onChange={(event) =>
                setArgs(args.map((value, i) => (i === index ? event.target.value : value)))
              }
              placeholder="--acp"
              className="font-mono"
              aria-label="Argument"
            />
            <Button
              type="button"
              variant="ghost"
              icon
              aria-label="Remove argument"
              onClick={() => setArgs(args.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setArgs([...args, ''])}
        >
          <Plus className="size-3.5" />
          Add argument
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-foreground-muted">Environment variables</span>
        {env.map((row, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={row.key}
              onChange={(event) =>
                setEnv(env.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))
              }
              placeholder="NAME"
              className="font-mono"
              aria-label="Variable name"
            />
            <Input
              value={row.value}
              onChange={(event) =>
                setEnv(env.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))
              }
              placeholder="value"
              className="font-mono"
              aria-label="Variable value"
            />
            <Button
              type="button"
              variant="ghost"
              icon
              aria-label="Remove variable"
              onClick={() => setEnv(env.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setEnv([...env, { key: '', value: '' }])}
        >
          <Plus className="size-3.5" />
          Add variable
        </Button>
        <span className="text-foreground-passive">
          Values are stored in Orkestra's settings. For API keys the agent asks for, use its sign-in
          section after running "Check agent"; those are kept in the secure store.
        </span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-foreground-muted">Working directory (optional, absolute path)</span>
        <Input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="Defaults to the conversation's workspace"
          className="font-mono"
        />
      </label>
      {preview ? (
        <div className="rounded-md bg-background-1 p-2 font-mono break-all text-foreground-muted">
          {preview}
        </div>
      ) : null}
      <p className="text-foreground-passive">
        Orkestra launches the executable directly without a shell, so shell expressions are not
        expanded. The command is only run when you start a conversation or run "Check agent".
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={add.isPending || !name.trim() || !command.trim()}
        >
          {add.isPending ? <Spinner size="sm" /> : null}
          Add command
        </Button>
      </div>
    </form>
  );
}
