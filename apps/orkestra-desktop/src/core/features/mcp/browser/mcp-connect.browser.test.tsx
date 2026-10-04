import { hostRef } from '@orkestra/core/primitives/host/api';
import type { McpCatalogEntry, McpServer } from '@orkestra/core/primitives/mcp/api';
import { ok } from '@orkestra/shared';
import { defineContract } from '@orkestra/wire/rpc';
import { cell, expose } from '@orkestra/wire/state';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedSliceWire } from '@core/primitives/wire/browser/testing';
import { mcpContract, mcpDomain } from '../api';
import type { McpConnectionState } from '../api/connection';
import { McpCard } from './components/McpCard';
import { McpConnectSheet } from './components/McpConnectSheet';

const nestedMcpContract = defineContract({ [mcpDomain]: mcpContract })[mcpDomain];
const host = hostRef('remote', 'huawei');
const entry: McpCatalogEntry = {
  key: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'Ses üretimi',
  docsUrl: 'https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp',
  defaultConfig: { type: 'http', url: 'https://api.us.elevenlabs.io/v1/mcp' },
  credentialKeys: [],
};
const existing: McpServer = {
  name: 'elevenlabs',
  transport: 'stdio',
  command: '/home/selim/.local/bin/orkestra-elevenlabs-mcp',
  providers: ['claude', 'codex'],
};
const providers = [
  { id: 'claude', name: 'Claude', installed: true },
  { id: 'codex', name: 'Codex', installed: true },
];

describe('MCP card account reconnection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let wire: { dispose: () => Promise<void> };
  const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = testEnvironment.IS_REACT_ACT_ENVIRONMENT;
  let phase: McpConnectionState['phase'];
  const connect = vi.fn(async () =>
    ok({ id: 'login', phase: 'starting' as const, message: 'Başlıyor' })
  );
  const cancel = vi.fn(async () => {});

  beforeEach(() => {
    testEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    connect.mockClear();
    cancel.mockClear();
    phase = 'awaiting-authorization';
    wire = seedSliceWire(mcpDomain, mcpContract, {
      servers: expose(nestedMcpContract.servers, { list: cell<McpServer[]>([]) }),
      connect,
      connectionStatus: async () => ({
        id: 'login',
        phase,
        message: phase === 'failed' ? 'Yeniden deneyin' : 'Onay bekleniyor',
      }),
      cancelConnection: cancel,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await wire.dispose();
    testEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('exposes a reconnect button for an installed stdio bridge without opening advanced settings', async () => {
    const reconnect = vi.fn();
    const advanced = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { enabled: false } } })}
        >
          <McpCard
            server={existing}
            catalogEntry={entry}
            providers={providers}
            onConnect={reconnect}
            onEdit={advanced}
          />
        </QueryClientProvider>
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="ElevenLabs hesabını yeniden bağla"]'
    );
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(advanced).not.toHaveBeenCalled();
    reconnect.mockClear();
    button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reconnects the legacy bridge via official OAuth on the selected remote host and keeps the attempt stable during live updates', async () => {
    const render = () =>
      root.render(
        <McpConnectSheet
          host={{ ...host }}
          hostLabel="Huawei"
          entry={{ ...entry }}
          existing={{ ...existing }}
          providers={[...providers]}
          onClose={() => {}}
          onAdvanced={() => {}}
        />
      );
    await act(async () => render());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledWith(
      {
        host,
        server: {
          name: 'elevenlabs',
          transport: 'http',
          url: entry.defaultConfig.url,
          providers: ['claude', 'codex'],
        },
      },
      expect.anything()
    );
    expect(document.body.textContent).toContain('Bağlantının kullanılacağı makine: Huawei');
    await act(async () => render());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: 'login' }, expect.anything()));
  });

  it('allows a failed login to be retried directly from the sheet', async () => {
    phase = 'failed';
    await act(async () =>
      root.render(
        <McpConnectSheet
          host={host}
          hostLabel="Huawei"
          entry={entry}
          existing={existing}
          providers={providers}
          onClose={() => {}}
          onAdvanced={() => {}}
        />
      )
    );
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Yeniden bağla'
        )
      ).toBe(true)
    );
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Yeniden bağla'
    )!;
    phase = 'connected';
    await act(async () => retry.click());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('button')].some((button) => button.textContent === 'Tamam')
      ).toBe(true)
    );
  });
});
