// Ajan ayrıntı panelinde kullanıcı ACP ajanlarına özel bölüm: neyin çalıştırıldığı, sabitlenen
// sürüm, yetenek yoklaması, giriş yöntemleri (terminal girişi / sır deposundaki API anahtarı),
// güncelleme ve kaldırma.
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { Alert, Badge, Button, Input, Spinner, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { openModal } from '@core/manifests/browser/modal-api';
import type { CustomAgentView } from '../../api/schemas';
import { ACP_REGISTRY_QUERY_KEY, getAcpRegistryClient, unwrapAcp } from '../../browser/client';

/** Kullanıcı ACP ajanlarının sağlayıcı kimlik öneki (yerleşik kimlikler bununla başlamaz). */
export function isCustomAcpAgentId(id: string): boolean {
  return id.startsWith('acp-');
}

export function useCustomAcpAgents() {
  return useQuery<CustomAgentView[]>({
    queryKey: [...ACP_REGISTRY_QUERY_KEY, 'list'],
    queryFn: async () => unwrapAcp(await (await getAcpRegistryClient()).list(undefined)),
    staleTime: 10_000,
  });
}

export function CustomAcpAgentDetail({
  providerId,
  onRemoved,
}: {
  providerId: string;
  onRemoved?: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: agents, isLoading } = useCustomAcpAgents();
  const agent = agents?.find((candidate) => candidate.providerId === providerId);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ACP_REGISTRY_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  };
  const probe = useMutation({
    mutationFn: async () => unwrapAcp(await (await getAcpRegistryClient()).probe({ providerId })),
    onSuccess: (view) => {
      invalidate();
      if (view.probe?.sessionError) {
        toast.warning('Agent answered, but could not open a session', {
          description: view.probe.sessionError,
        });
      } else toast.success('Agent check completed');
    },
    onError: (error: Error) => toast.error('Agent check failed', { description: error.message }),
  });
  const remove = useMutation({
    mutationFn: async () => unwrapAcp(await (await getAcpRegistryClient()).remove({ providerId })),
    onSuccess: () => {
      invalidate();
      onRemoved?.();
    },
    onError: (error: Error) =>
      toast.error('Could not remove the agent', { description: error.message }),
  });
  const update = useMutation({
    mutationFn: async (registryAgentId: string) =>
      unwrapAcp(
        await (
          await getAcpRegistryClient()
        ).previewRegistryAgent({ agentId: registryAgentId, replacesProviderId: providerId })
      ),
    onError: (error: Error) => toast.error('No update available', { description: error.message }),
  });

  if (isLoading) return <Spinner size="sm" />;
  if (!agent) return null;

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {agent.source === 'registry' ? 'ACP Registry' : 'Local ACP command'}
        </Badge>
        {agent.registry ? (
          <Badge variant="outline">
            {agent.registry.distribution} · {agent.registry.version} (pinned)
          </Badge>
        ) : null}
        <Badge variant="outline">This computer only</Badge>
      </div>
      {!agent.executableAvailable ? (
        <Alert.Root status="warning">
          The agent's executable was not found. Check the command or reinstall the agent.
        </Alert.Root>
      ) : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-foreground-passive">Runs</dt>
        <dd className="font-mono break-all">{agent.launchCommand.join(' ')}</dd>
        {agent.cwd ? (
          <>
            <dt className="text-foreground-passive">Working directory</dt>
            <dd className="font-mono break-all">{agent.cwd}</dd>
          </>
        ) : null}
        {agent.launchEnvNames.length > 0 ? (
          <>
            <dt className="text-foreground-passive">Environment</dt>
            <dd className="font-mono break-all">{agent.launchEnvNames.join(', ')}</dd>
          </>
        ) : null}
        {agent.registry?.archiveUrl ? (
          <>
            <dt className="text-foreground-passive">Downloaded from</dt>
            <dd className="font-mono break-all">{agent.registry.archiveUrl}</dd>
            <dt className="text-foreground-passive">SHA-256</dt>
            <dd className="font-mono break-all">
              {agent.registry.sha256 ?? 'Not declared (HTTPS only)'}
            </dd>
          </>
        ) : null}
        {agent.registry?.packageSpec ? (
          <>
            <dt className="text-foreground-passive">Package</dt>
            <dd className="font-mono break-all">{agent.registry.packageSpec}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-foreground">Agent check</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}
          >
            {probe.isPending ? <Spinner size="sm" /> : null}
            Check agent
          </Button>
        </div>
        {agent.probe ? (
          <div className="flex flex-col gap-1 text-foreground-muted">
            <span>
              {agent.probe.agentName ?? agent.name}
              {agent.probe.agentVersion ? ` ${agent.probe.agentVersion}` : ''} · ACP v
              {agent.probe.protocolVersion ?? '?'} · checked{' '}
              {new Date(agent.probe.probedAt).toLocaleString()}
            </span>
            <span>Resume saved sessions: {agent.probe.loadSession ? 'yes' : 'no'}</span>
            {agent.probe.models.length > 0 ? (
              <span>
                Models:{' '}
                {agent.probe.models
                  .slice(0, 12)
                  .map((model) => model.name)
                  .join(', ')}
                {agent.probe.models.length > 12 ? ` (+${agent.probe.models.length - 12})` : ''}
              </span>
            ) : null}
            {agent.probe.modes.length > 0 ? (
              <span>Modes: {agent.probe.modes.map((mode) => mode.name).join(', ')}</span>
            ) : null}
            {agent.probe.sessionError ? (
              <span className="text-foreground-warning">
                Could not open a session: {agent.probe.sessionError}. Sign in below and check again.
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-foreground-muted">
            Not checked yet. Checking starts the agent briefly to read its sign-in methods, models
            and modes.
          </span>
        )}
      </div>

      {agent.authMethods.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <span className="font-medium text-foreground">Sign in</span>
          {agent.authMethods.map((method) => (
            <AuthMethodRow key={method.id} agent={agent} method={method} onChanged={invalidate} />
          ))}
        </div>
      ) : null}

      {update.data ? (
        <Alert.Root status="warning">
          {update.data.name} {update.data.version} is available. Use Browse ACP Registry on the
          Agents page and choose Update to review and install it.
        </Alert.Root>
      ) : null}

      <div className="flex justify-end gap-2">
        {agent.registry ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate(agent.registry!.agentId)}
          >
            Check for updates
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? <Spinner size="sm" /> : null}
          Remove agent
        </Button>
      </div>
    </div>
  );
}

function AuthMethodRow({
  agent,
  method,
  onChanged,
}: {
  agent: CustomAgentView;
  method: CustomAgentView['authMethods'][number];
  onChanged: () => void;
}) {
  if (method.type === 'terminal') {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-foreground">{method.name}</span>
          {method.description ? (
            <span className="text-foreground-muted">{method.description}</span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void openModal('agentSignInModal', {
              providerId: agent.providerId,
              methodId: method.id,
              providerName: agent.name,
              host: LOCAL_HOST_REF,
            })
          }
        >
          Sign in
        </Button>
      </div>
    );
  }
  if (method.type === 'env_var') {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-foreground">{method.name}</span>
        {method.vars.map((variable) => (
          <EnvSecretInput
            key={variable.name}
            providerId={agent.providerId}
            name={variable.name}
            label={variable.label}
            configured={variable.configured}
            onChanged={onChanged}
          />
        ))}
        {method.link ? (
          <a
            href={method.link}
            target="_blank"
            rel="noreferrer"
            className="text-foreground-muted hover:text-foreground"
          >
            Get a key
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <span className="text-foreground">{method.name}</span>
      <span className="text-foreground-muted">
        The agent handles this sign-in itself when a conversation starts.
      </span>
    </div>
  );
}

function EnvSecretInput({
  providerId,
  name,
  label,
  configured,
  onChanged,
}: {
  providerId: string;
  name: string;
  label: string;
  configured: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: async (next: string | null) =>
      unwrapAcp(
        await (await getAcpRegistryClient()).setEnvSecret({ providerId, name, value: next })
      ),
    onSuccess: (_, next) => {
      setValue('');
      onChanged();
      toast.success(next ? `${name} saved to the secure store` : `${name} removed`);
    },
    onError: (error: Error) =>
      toast.error('Could not save the key', { description: error.message }),
  });
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground-muted">
        {label} <span className="font-mono">({name})</span>
        {configured ? ' · saved' : ''}
      </span>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={configured ? 'Replace saved value' : 'Paste key'}
          aria-label={label}
          autoComplete="off"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!value || save.isPending}
          onClick={() => save.mutate(value)}
        >
          Save
        </Button>
        {configured ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
