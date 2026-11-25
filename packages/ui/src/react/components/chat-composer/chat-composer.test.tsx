/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../prompt-editor/prompt-editor', () => ({
  PromptEditor: () => <div data-testid="prompt-editor" />,
}));

import { ChatComposer } from './index';

afterEach(cleanup);

describe('ChatComposer', () => {
  it('renders host toolbar accessories before the attach button', () => {
    const { getByRole } = render(
      <ChatComposer
        onSubmit={() => {}}
        onAttach={() => {}}
        toolbarAccessory={<button type="button">Sesle yaz</button>}
      />
    );
    const accessory = getByRole('button', { name: 'Sesle yaz' });
    const attach = getByRole('button', { name: 'Dosya ekle' });
    expect(
      accessory.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('shows startup failures on the MCP trigger and affected server, including while disabled', async () => {
    const { getByRole, findByRole, queryByText, getByText } = render(
      <ChatComposer
        disabled
        onSubmit={() => {}}
        mcpServers={[
          { name: 'docs', transport: 'http', startupError: 'Connection refused' },
          { name: 'filesystem', transport: 'stdio' },
        ]}
      />
    );
    const trigger = getByRole('button', { name: '2 MCP sunucusu, 1 başlatma hatası' });
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.hasAttribute('data-failed')).toBe(true);
    expect(trigger.textContent).toBe('2');
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
    fireEvent.click(trigger);
    const info = await findByRole('button', { name: 'docs startup error' });
    expect(queryByText('Connection refused')).toBeNull();
    expect(getByText('docs').parentElement?.parentElement?.hasAttribute('data-failed')).toBe(true);
    expect(getByText('docs').nextElementSibling).toBe(info);
    expect(getByText('http').hasAttribute('data-failed')).toBe(true);
    expect(getByText('stdio').hasAttribute('data-failed')).toBe(false);
    fireEvent.keyDown(document, { key: 'Tab' });
    info.focus();
    expect((await findByRole('tooltip')).textContent).toBe('Connection refused');
  });

  it('shows the selected effort beside the model and keeps the MCP trigger compact', () => {
    const { container, getByRole } = render(
      <ChatComposer
        modelOptions={{ 'gpt-5.6-sol': { name: 'GPT-5.6-Sol' } }}
        selectedModel="gpt-5.6-sol"
        onModelChange={() => {}}
        effortOptions={{ high: { name: 'High' } }}
        selectedEffort="high"
        onEffortChange={() => {}}
        mcpServers={[
          { name: 'Filesystem', transport: 'stdio' },
          { name: 'GitHub', transport: 'http' },
        ]}
        onSubmit={() => {}}
      />
    );

    const modelTrigger = container.querySelector('[data-slot="combobox-trigger"]');
    expect(modelTrigger?.textContent).toBe('GPT-5.6-Sol High');
    const mcpTrigger = getByRole('button', { name: '2 MCP sunucusu' });
    expect(mcpTrigger.textContent).toBe('2');
    expect(mcpTrigger.hasAttribute('data-failed')).toBe(false);
  });

  it('renders T3 3-column popover with grouped models, right-side effort panel and shortcuts', async () => {
    const onModelChange = vi.fn();
    const { container } = render(
      <ChatComposer
        modelOptions={{
          'gemini-4-neon-high': { name: 'Gemini 4 Neon (Yüksek)' },
          'gemini-4-neon-medium': { name: 'Gemini 4 Neon (Orta)' },
          'gemini-4-neon-low': { name: 'Gemini 4 Neon (Düşük)' },
          'gemini-pro-orchestrator-neon': { name: 'Orchestrator (Neon)' },
        }}
        selectedModel="gemini-4-neon-high"
        onModelChange={onModelChange}
        onSubmit={() => {}}
      />
    );

    const modelTrigger = container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
    expect(modelTrigger?.textContent).toBe('Gemini 4 Neon Yüksek');
    fireEvent.click(modelTrigger!);

    await waitFor(() => {
      const popup = document.body.querySelector<HTMLElement>('[data-model-picker-content="true"]');
      expect(popup).not.toBeNull();
      const rows = popup!.querySelectorAll<HTMLElement>('[data-model-picker-row="true"]');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain('Gemini 4 Neon');
      expect(rows[1]?.textContent).toContain('Orchestrator (Neon)');
      expect(popup!.textContent).toContain('⌘1');
      expect(popup!.textContent).toContain('Düşünme');
      const effortPanel = popup!.querySelector<HTMLElement>('[data-model-picker-effort="true"]');
      expect(effortPanel?.textContent).toContain('Yüksek');
    });

    const mediumBtn = document.body.querySelector<HTMLElement>(
      '[data-effort-choice="gemini-4-neon-medium"]'
    );
    expect(mediumBtn).not.toBeNull();
    fireEvent.click(mediumBtn!);
    expect(onModelChange).toHaveBeenCalledWith('gemini-4-neon-medium');
  });

  it('supports unified multi-provider rail, cross-provider search, favorites and Cmd+1 shortcut', async () => {
    localStorage.clear();
    const onProviderModelChange = vi.fn();
    const onModelChange = vi.fn();
    const { container } = render(
      <ChatComposer
        selectedAgent="claude"
        selectedModel="claude-opus-5-5"
        selectedEffort="medium"
        onModelChange={onModelChange}
        onProviderModelChange={onProviderModelChange}
        providerSwitchHint={(id) =>
          id !== 'claude' ? 'Aynı sohbette bağlam aktarımı ile geçilir' : null
        }
        providerCatalog={[
          {
            id: 'claude',
            name: 'Claude Code',
            models: {
              'claude-opus-5-5': { name: 'Claude Opus 5.5' },
              'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5' },
            },
            efforts: {
              low: { name: 'Low' },
              medium: { name: 'Medium' },
              high: { name: 'High' },
            },
          },
          {
            id: 'codex',
            name: 'Codex',
            models: {
              'gpt-6.2-sol': { name: 'GPT-6.2 Sol' },
              'gpt-6-luna': { name: 'GPT-6 Luna' },
            },
            efforts: {
              low: { name: 'Low' },
              medium: { name: 'Medium' },
              high: { name: 'High' },
            },
          },
        ]}
        onSubmit={() => {}}
      />
    );

    const modelTrigger = container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
    fireEvent.click(modelTrigger!);

    await waitFor(() => {
      expect(document.body.querySelector('[data-model-picker-sidebar="true"]')).not.toBeNull();
    });

    // Favori ekleme ve Favoriler sekmesi
    const favBtn = document.body.querySelector<HTMLElement>('button[aria-label="Favorilere ekle"]');
    expect(favBtn).not.toBeNull();
    fireEvent.click(favBtn!);

    const favoritesTab = document.body.querySelector<HTMLElement>('button[aria-label="Favoriler"]');
    fireEvent.click(favoritesTab!);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[data-model-picker-row="true"]')).toHaveLength(1);
    });

    // Sağlayıcı değiştirme (Codex sekmesine geç) + ipucu
    const codexTab = document.body.querySelector<HTMLElement>(
      '[data-model-picker-provider="codex"]'
    );
    fireEvent.click(codexTab!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('GPT-6.2 Sol');
      expect(document.body.textContent).toContain('Aynı sohbette bağlam aktarımı ile geçilir');
    });

    // Çapraz arama ve ⌘1 ile hızlı seçim
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Model ara..."]'
    );
    fireEvent.change(search!, { target: { value: 'luna' } });
    await waitFor(() => {
      const rows = document.body.querySelectorAll('[data-model-picker-row="true"]');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain('GPT-6 Luna');
    });

    const popup = document.body.querySelector<HTMLElement>('[data-model-picker-content="true"]');
    fireEvent.keyDown(popup!, { key: '1', metaKey: true });
    expect(onProviderModelChange).toHaveBeenCalledWith('codex', 'gpt-6-luna', 'medium');
  });

  it('caps the permission-mode popup at its compact width', async () => {
    render(
      <ChatComposer
        permissionModeOptions={{
          readOnly: {
            name: 'Read-only',
            description: 'Requires approval to edit files and run commands.',
          },
          fullAccess: {
            name: 'Agent (full access)',
            description:
              'Can edit files outside this workspace and run commands with network access.',
          },
        }}
        selectedPermissionMode="readOnly"
        onPermissionModeChange={() => {}}
        onSubmit={() => {}}
      />
    );

    const trigger = document.body.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    await waitFor(() => {
      const popup = document.body.querySelector<HTMLElement>('[data-slot="select-content"]');
      expect(popup).not.toBeNull();
      expect(popup!.style.width).toBe('min(18rem, var(--available-width, 18rem))');
      expect(popup!.style.minWidth).toBe('0px');
      expect(popup!.style.maxWidth).toBe('18rem');
    });
  });

  it('exposes collaboration mode separately from permission mode', async () => {
    const onCollaborationModeChange = vi.fn();
    render(
      <ChatComposer
        collaborationModeOptions={{
          default: { name: 'Default' },
          plan: { name: 'Plan', description: 'Plan before making changes' },
        }}
        selectedCollaborationMode="default"
        onCollaborationModeChange={onCollaborationModeChange}
        permissionModeOptions={{ agent: { name: 'Agent' } }}
        selectedPermissionMode="agent"
        onPermissionModeChange={() => {}}
        onSubmit={() => {}}
      />
    );

    const collaborationTrigger = document.body.querySelector<HTMLElement>(
      '[aria-label="Çalışma kipi"]'
    );
    // The name is also the tooltip: in a narrow pane the label collapses to the icon.
    expect(collaborationTrigger?.getAttribute('title')).toBe('Çalışma kipi: Default');
    expect(document.body.querySelector('[aria-label="İzin kipi"]')?.getAttribute('title')).toBe(
      'İzin kipi: Agent'
    );
    const triggers = document.body.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]');
    expect(collaborationTrigger).not.toBeNull();
    expect(Array.from(triggers).map((trigger) => trigger.textContent)).toEqual([
      'Default',
      'Agent',
    ]);

    fireEvent.click(collaborationTrigger!);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[data-slot="select-item"]')).toHaveLength(2);
    });
    const planItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')
    ).find((item) => item.textContent?.includes('Plan'));
    expect(planItem).toBeDefined();
    fireEvent.pointerDown(planItem!, { pointerType: 'mouse', button: 0 });
    fireEvent.click(planItem!, { detail: 1 });

    await waitFor(() => expect(onCollaborationModeChange).toHaveBeenCalledWith('plan'));
  });
  describe('agent selector on a started conversation', () => {
    const agents = [
      { id: 'kimi', name: 'Kimi' },
      { id: 'claude', name: 'Claude', badge: { label: 'limit doldu', tone: 'danger' as const } },
      { id: 'codex', name: 'Codex' },
    ];

    it('stays a disabled icon button when locked', () => {
      const { getByRole } = render(
        <ChatComposer
          agentOptions={agents}
          selectedAgent="kimi"
          agentLocked
          onAgentChange={() => {}}
          onSubmit={() => {}}
        />
      );
      const trigger = getByRole('button', {
        name: 'Kimi — sohbet başladıktan sonra ajan değiştirilemez',
      });
      expect(trigger.hasAttribute('disabled')).toBe(true);
    });

    it('opens in handoff mode, lists the others with badges and reports the pick', async () => {
      const onAgentChange = vi.fn();
      const { getByRole } = render(
        <ChatComposer
          agentOptions={agents}
          selectedAgent="kimi"
          agentLocked
          agentSwitchMode="handoff"
          onAgentChange={onAgentChange}
          modelOptions={{ k3: { name: 'K3' } }}
          selectedModel="k3"
          onModelChange={() => {}}
          onSubmit={() => {}}
        />
      );
      const trigger = getByRole('combobox', {
        name: 'Kimi — başka ajanla devam etmek için tıklayın',
      });
      expect(trigger.hasAttribute('disabled')).toBe(false);
      fireEvent.click(trigger);

      await waitFor(() => {
        expect(document.body.textContent).toContain('Başka ajanla devam et');
      });
      expect(document.body.textContent).toContain('Şu anki ajan');
      expect(document.body.textContent).toContain('limit doldu');

      const claude = Array.from(
        document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')
      ).find((item) => item.textContent?.includes('Claude'));
      expect(claude).toBeDefined();
      fireEvent.click(claude!);
      await waitFor(() => expect(onAgentChange).toHaveBeenCalledWith('claude'));
    });
  });

  it('offers the context handoff from the usage popover and runs it once', async () => {
    const onMoveToNewContext = vi.fn();
    const { getByRole, findByRole, rerender } = render(
      <ChatComposer
        onSubmit={() => {}}
        contextUsage={{ used: 180_000, size: 200_000 }}
        onCompact={() => {}}
        onMoveToNewContext={onMoveToNewContext}
      />
    );
    fireEvent.click(getByRole('button', { name: 'Bağlam penceresi: %90 kullanıldı' }));
    const move = await findByRole('button', { name: 'Yeni sohbete taşı' });
    expect(move.hasAttribute('disabled')).toBe(false);
    fireEvent.click(move);
    expect(onMoveToNewContext).toHaveBeenCalledTimes(1);

    // Disabled when the host says there is nothing to move (e.g. an empty conversation).
    rerender(
      <ChatComposer
        onSubmit={() => {}}
        contextUsage={{ used: 180_000, size: 200_000 }}
        onMoveToNewContext={onMoveToNewContext}
        moveToNewContextDisabled
      />
    );
    fireEvent.click(getByRole('button', { name: 'Bağlam penceresi: %90 kullanıldı' }));
    const disabledMove = await findByRole('button', { name: 'Yeni sohbete taşı' });
    expect(disabledMove.hasAttribute('disabled')).toBe(true);
  });
});
