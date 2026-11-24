import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Badge, Button, Input, Switch, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getOutsideAgentsClient } from '@core/features/outside-agents/api/browser/client';
import {
  DEFAULT_OUTSIDE_AGENTS_PORT,
  type CreatedOutsideAgentClient,
  type OutsideAgentAccess,
  type OutsideAgentClient,
  type OutsideAgentsStatus,
} from '@core/features/outside-agents/api/contract';

// Ayarlar > Dış ajanlar (MCP): Orkestra'nın başlatmadığı ajanlar (terminaldeki Claude Code / Codex,
// bot'lar) yerel MCP sunucusuna bağlanır. Varsayılan kapalıdır; her istemciye ayrı belirteç ve
// yetki (yalnızca okuma / okuma + eylem) verilir, istemciler buradan iptal edilir.

const STATUS_QUERY_KEY = ['outside-agents', 'status'] as const;

function formatTime(value: number | null): string {
  if (value === null) return 'Never';
  return new Date(value).toLocaleString();
}

function accessLabel(access: OutsideAgentAccess): string {
  return access === 'act' ? 'Read and act' : 'Read only';
}

export function OutsideAgentsSettingsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: async (): Promise<OutsideAgentsStatus> => (await getOutsideAgentsClient()).getStatus(),
    refetchInterval: 5000,
  });
  const data = status.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
  const [created, setCreated] = useState<CreatedOutsideAgentClient | null>(null);

  const configure = useMutation({
    mutationFn: async (patch: { enabled?: boolean; port?: number }) => {
      const result = await (await getOutsideAgentsClient()).configure(patch);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: refresh,
    onError: (error) => toast.error('Could not save the setting', { description: error.message }),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const result = await (await getOutsideAgentsClient()).revokeClient({ id });
      if (!result.success) throw new Error(result.error.message);
    },
    onSuccess: () => {
      toast.success('Client revoked');
      refresh();
    },
    onError: (error) => toast.error('Could not revoke the client', { description: error.message }),
  });

  const setAccess = useMutation({
    mutationFn: async (input: { id: string; access: OutsideAgentAccess }) => {
      const result = await (await getOutsideAgentsClient()).setClientAccess(input);
      if (!result.success) throw new Error(result.error.message);
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error('Could not change the permission', { description: error.message }),
  });

  const enabled = data?.enabled ?? false;

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Outside agents (MCP)"
        description="Let agents that Orkestra did not start, such as Claude Code or Codex in your own terminal or a chat bot, list projects, read conversations and start or continue conversations through a local MCP server. Off by default."
      />

      {data?.listenError && (
        <Alert.Root status="warning">
          <Alert.Title>The MCP server could not start</Alert.Title>
          <Alert.Description>{data.listenError}</Alert.Description>
        </Alert.Root>
      )}
      {data && !data.secureStorageAvailable && (
        <Alert.Root status="warning">
          <Alert.Title>Secure storage is not available</Alert.Title>
          <Alert.Description>
            Orkestra cannot store client tokens safely on this system, so this feature stays off.
          </Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="Server">
        <SettingsRow
          label="Allow outside agents"
          description="When on, Orkestra listens on this computer only (127.0.0.1). Every client needs its own token."
          control={
            <Switch
              checked={enabled}
              disabled={!data || configure.isPending || !data.secureStorageAvailable}
              onCheckedChange={(next) => configure.mutate({ enabled: next })}
            />
          }
        />
        <SettingsRow
          label="MCP URL"
          description={
            data?.url
              ? 'Clients connect to this address with the streamable HTTP transport.'
              : 'Turn the server on to get the address.'
          }
          control={
            data?.url ? (
              <div className="flex items-center gap-2">
                <code className="text-sm">{data.url}</code>
                <CopyButton value={data.url} />
              </div>
            ) : null
          }
        />
        <PortRow status={data} onSave={(port) => configure.mutate({ port })} />
        <SettingsRow
          label="What clients can do"
          description="Read only: list projects and conversations, read messages and status, see providers and models. Read and act: also start conversations and send messages. Conversations they start appear here live; permission prompts are always answered by you in Orkestra."
          control={null}
        />
      </SettingsSection>

      <ConnectClientSection
        disabled={!data?.secureStorageAvailable}
        onCreated={(result) => {
          setCreated(result);
          refresh();
        }}
      />

      {created && <CreatedClientPanel created={created} onClose={() => setCreated(null)} />}

      <SettingsSection title="Connected clients">
        {(data?.clients.length ?? 0) === 0 ? (
          <SettingsRow
            label="No clients yet"
            description="Connect a client above."
            control={null}
          />
        ) : (
          data?.clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              busy={revoke.isPending || setAccess.isPending}
              onRevoke={() => revoke.mutate(client.id)}
              onToggleAccess={() =>
                setAccess.mutate({
                  id: client.id,
                  access: client.access === 'act' ? 'read' : 'act',
                })
              }
            />
          ))
        )}
      </SettingsSection>
    </div>
  );
}

function ClientRow({
  client,
  busy,
  onRevoke,
  onToggleAccess,
}: {
  client: OutsideAgentClient;
  busy: boolean;
  onRevoke: () => void;
  onToggleAccess: () => void;
}) {
  return (
    <SettingsRow
      label={client.name}
      description={`Added ${formatTime(client.createdAt)} · Last used ${formatTime(client.lastUsedAt)}`}
      control={
        <div className="flex items-center gap-2">
          <Badge>{accessLabel(client.access)}</Badge>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onToggleAccess}>
            {client.access === 'act' ? 'Make read only' : 'Allow acting'}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRevoke}>
            Revoke
          </Button>
        </div>
      }
    />
  );
}

function ConnectClientSection({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (created: CreatedOutsideAgentClient) => void;
}) {
  const [name, setName] = useState('');
  const [access, setAccess] = useState<OutsideAgentAccess>('read');
  const create = useMutation({
    mutationFn: async () => {
      const result = await (
        await getOutsideAgentsClient()
      ).createClient({
        name: name.trim(),
        access,
      });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (result) => {
      setName('');
      onCreated(result);
    },
    onError: (error) => toast.error('Could not create the client', { description: error.message }),
  });
  return (
    <SettingsSection title="Connect a client">
      <SettingsRow
        label="Client name"
        description="A name you recognize, for example Claude Code on this Mac or Hermes bot."
        control={
          <Input
            aria-label="Client name"
            placeholder="Claude Code"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            className="w-[220px]"
          />
        }
      />
      <SettingsRow
        label="Permission"
        description="You can change it or revoke the client later."
        control={
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={access === 'read' ? 'primary' : 'secondary'}
              onClick={() => setAccess('read')}
            >
              Read only
            </Button>
            <Button
              size="sm"
              variant={access === 'act' ? 'primary' : 'secondary'}
              onClick={() => setAccess('act')}
            >
              Read and act
            </Button>
          </div>
        }
      />
      <SettingsRow
        label="Create a token"
        description="The token is shown once. Orkestra keeps only a fingerprint of it."
        control={
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            Create token
          </Button>
        }
      />
    </SettingsSection>
  );
}

function CreatedClientPanel({
  created,
  onClose,
}: {
  created: CreatedOutsideAgentClient;
  onClose: () => void;
}) {
  return (
    <SettingsSection title="Set up the client">
      <Alert.Root status="info">
        <Alert.Title>Copy the token now</Alert.Title>
        <Alert.Description>
          This is the only time the token is shown. Orkestra does not write it into any other app's
          configuration; paste one of the snippets below yourself.
        </Alert.Description>
      </Alert.Root>
      <SnippetBlock label="Token" value={created.token} />
      <SnippetBlock label="Claude Code (run in a terminal)" value={created.setup.claudeCode} />
      <SnippetBlock label="Codex (~/.codex/config.toml)" value={created.setup.codexToml} />
      <SnippetBlock
        label="Codex (shell profile, keeps the token out of config.toml)"
        value={created.setup.codexEnv}
      />
      <SnippetBlock label="Other MCP clients (streamable HTTP URL)" value={created.url} />
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </SettingsSection>
  );
}

function SnippetBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-background-secondary p-2 text-xs break-all whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => toast.success('Copied'))
          .catch(() => toast.error('Could not copy'));
      }}
    >
      Copy
    </Button>
  );
}

function PortRow({
  status,
  onSave,
}: {
  status: OutsideAgentsStatus | undefined;
  onSave: (port: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(status?.port ?? DEFAULT_OUTSIDE_AGENTS_PORT);
  const port = Number(shown);
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  return (
    <SettingsRow
      label="Port"
      description="Local port of the MCP server. Changing it breaks the setup of existing clients."
      control={
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              onSave(port);
              setDraft(null);
            }
          }}
        >
          <Input
            inputMode="numeric"
            aria-label="Port"
            value={shown}
            onChange={(event) => setDraft(event.target.value)}
            className="w-[100px]"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!valid || draft === null}>
            Save
          </Button>
        </form>
      }
    />
  );
}
