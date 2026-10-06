import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostMaintenanceState,
  ServerActivity,
} from '@core/services/hosts/api/maintenance-contract';
import type { HostMaintenanceActions } from '../use-host-maintenance';
import { WorkspaceServerMaintenanceCard } from './workspace-server-maintenance-card';

const NOW = 10 * 60 * 60_000;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function createActions(activity: ServerActivity): HostMaintenanceActions {
  return {
    check: vi.fn(async () => {}),
    inspectActivity: vi.fn(async () => activity),
    updateNow: vi.fn(async () => {}),
    inspectHealth: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
  };
}

const idle: ServerActivity = { checkedAt: NOW, items: [], complete: true };
const busy: ServerActivity = {
  checkedAt: NOW,
  complete: true,
  items: [{ kind: 'agent-turn', id: 'c1', label: 'Fix login bug' }],
};

const waitingState: HostMaintenanceState = {
  status: 'waiting-for-idle',
  runningVersion: '1.2.3',
  availableVersion: '1.2.4',
  lastCheckedAt: NOW - 5 * 60_000,
  daemonStartedAt: NOW - 2 * 60 * 60_000,
  health: {
    checkedAt: NOW,
    rootBytes: 400 * 1024 * 1024,
    freeBytes: 20 * 1024 * 1024 * 1024,
    prunableBytes: 100 * 1024 * 1024,
    versions: [
      { name: '1.2.3', role: 'current', bytes: 100 * 1024 * 1024 },
      { name: '1.2.2', role: 'previous', bytes: 100 * 1024 * 1024 },
      { name: '1.2.1', role: 'prunable', bytes: 100 * 1024 * 1024 },
    ],
  },
};

describe('WorkspaceServerMaintenanceCard', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(
    state: HostMaintenanceState | undefined,
    actions: HostMaintenanceActions,
    confirm = vi.fn(async () => true)
  ) {
    await act(async () => {
      root.render(
        <WorkspaceServerMaintenanceCard
          state={state}
          actions={actions}
          confirm={confirm}
          now={NOW}
        />
      );
    });
    return confirm;
  }

  function button(label: string): HTMLButtonElement {
    const match = [...host.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(label)
    );
    if (!match) throw new Error(`Button '${label}' not found`);
    return match;
  }

  it('shows versions, last check, uptime, disk usage and the waiting status', async () => {
    await render(waitingState, createActions(idle));
    const text = host.textContent ?? '';
    expect(text).toContain('Boşta olmasını bekliyor');
    expect(text).toContain('Çalışan: v1.2.3');
    expect(text).toContain('Kanal: v1.2.4');
    expect(text).toContain('Son denetim: 5 dk önce');
    expect(text).toContain('Çalışma süresi: 2 sa 0 dk');
    expect(text).toContain('Disk kullanımı: 400 MB');
    expect(text).toContain('v1.2.1 · Temizlenebilir');
    expect(button('Güncelle').disabled).toBe(false);
    expect(button('Eski sürümleri temizle').disabled).toBe(false);
  });

  it('disables update and prune when nothing applies', async () => {
    await render(
      {
        status: 'up-to-date',
        runningVersion: '1.2.4',
        availableVersion: '1.2.4',
        health: { checkedAt: NOW, prunableBytes: 0, versions: [] },
      },
      createActions(idle)
    );
    expect(host.textContent).toContain('Güncel');
    expect(button('Güncelle').disabled).toBe(true);
    expect(button('Eski sürümleri temizle').disabled).toBe(true);
  });

  it('updates an idle server without asking for confirmation', async () => {
    const actions = createActions(idle);
    const confirm = await render(waitingState, actions);
    await act(async () => button('Güncelle').click());
    expect(confirm).not.toHaveBeenCalled();
    expect(actions.updateNow).toHaveBeenCalledTimes(1);
  });

  it('lists interrupted work and respects a declined confirmation', async () => {
    const actions = createActions(busy);
    const confirm = vi.fn(async () => false);
    await render(waitingState, actions, confirm);
    await act(async () => button('Güncelle').click());
    expect(confirm).toHaveBeenCalledTimes(1);
    const firstCall = confirm.mock.calls[0] as unknown as [{ description: unknown }];
    const preview = document.createElement('div');
    const previewRoot = createRoot(preview);
    await act(async () => previewRoot.render(<>{firstCall[0].description as never}</>));
    expect(preview.textContent).toContain('Ajan turu: Fix login bug');
    await act(async () => previewRoot.unmount());
    expect(actions.updateNow).not.toHaveBeenCalled();
  });

  it('updates a busy server once the user confirms', async () => {
    const actions = createActions(busy);
    await render(
      waitingState,
      actions,
      vi.fn(async () => true)
    );
    await act(async () => button('Güncelle').click());
    expect(actions.updateNow).toHaveBeenCalledTimes(1);
  });

  it('runs Denetle and confirmed pruning', async () => {
    const actions = createActions(idle);
    await render(waitingState, actions);
    await act(async () => button('Denetle').click());
    expect(actions.check).toHaveBeenCalledTimes(1);
    await act(async () => button('Eski sürümleri temizle').click());
    expect(actions.prune).toHaveBeenCalledTimes(1);
  });
});
