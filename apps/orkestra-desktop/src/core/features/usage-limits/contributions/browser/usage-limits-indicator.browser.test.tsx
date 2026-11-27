import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { UsageLimitsIndicator } from './usage-limits-indicator';

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn(),
  consumeResetCredit: vi.fn(async () => ({
    outcome: 'reset' as const,
    message: 'Sıfırlama hakkı kullanıldı; kullanım limitleri sıfırlandı.',
  })),
  now: Date.UTC(2026, 10, 24, 10, 0, 0),
}));

vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: fixture.navigate }),
}));

vi.mock('@core/features/usage-limits/browser/use-usage-limits', () => ({
  useMinuteClock: () => fixture.now,
  useConsumeResetCredit: () => ({
    consumeResetCredit: fixture.consumeResetCredit,
    isRedeeming: false,
    redeemingProviderId: null,
  }),
  useUsageLimits: () => ({
    snapshot: {
      providers: [
        {
          providerId: 'claude',
          status: 'available',
          windows: [
            {
              label: 'Haftalık kota',
              usedPercent: 4,
              resetsAt: new Date(fixture.now + 6 * 86_400_000).toISOString(),
            },
          ],
          balances: [],
          plan: 'max',
          source: 'session',
          measuredAt: new Date(fixture.now).toISOString(),
          fetchedAt: fixture.now,
        },
        {
          providerId: 'codex',
          status: 'available',
          windows: [
            {
              label: 'codex · Haftalık',
              usedPercent: 84,
              resetsAt: new Date(fixture.now + 3 * 86_400_000).toISOString(),
            },
          ],
          balances: [],
          resetCredits: {
            availableCount: 1,
            canRedeem: true,
            credits: [
              {
                id: 'credit-1',
                title: 'Full reset',
                expiresAt: new Date(fixture.now + 10 * 86_400_000).toISOString(),
                status: 'available',
              },
            ],
          },
          plan: 'prolite',
          source: 'Codex CLI',
          measuredAt: new Date(fixture.now).toISOString(),
          fetchedAt: fixture.now,
        },
      ],
    },
    isLoading: false,
    isError: false,
    isRefreshing: false,
    refresh: fixture.refresh,
  }),
}));

describe('UsageLimitsIndicator', () => {
  let container: HTMLDivElement;
  let root: Root;
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <UsageLimitsIndicator
          trigger={<button type="button" onMouseDown={(e) => e.preventDefault()} />}
        />
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  });

  it('does not open or navigate on hover', async () => {
    await userEvent.hover(page.getByRole('button', { name: 'Limitler' }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).not.toBeInTheDocument();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it('toggles popover on click without navigating to settings', async () => {
    const trigger = page.getByRole('button', { name: 'Limitler' });

    await userEvent.click(trigger);
    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).toBeVisible();
    await expect
      .element(page.getByText('Oturumlardan okunur, 3 dk’da bir yenilenir.'))
      .toBeVisible();
    expect(fixture.navigate).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).not.toBeInTheDocument();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it('navigates to settings only when clicking Tümünü gör', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Limitler' }));
    await userEvent.click(page.getByRole('button', { name: 'Tümünü gör' }));

    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).not.toBeInTheDocument();
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
    expect(fixture.navigate).toHaveBeenCalledWith(settingsViewDef({ tab: 'clis-models' }));
  });

  it('closes popover on Escape', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Limitler' }));
    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).toBeVisible();

    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('button', { name: 'Tümünü gör' })).not.toBeInTheDocument();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it('displays reset credit expiry and redeems only after inline confirmation', async () => {
    await userEvent.click(page.getByRole('button', { name: 'Limitler' }));
    await expect.element(page.getByText('Limit sıfırlama hakkı')).toBeVisible();
    await expect.element(page.getByText(/Son kullanma:/)).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Sıfırlama hakkını kullan' }));
    expect(fixture.consumeResetCredit).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole('button', { name: 'Evet, sıfırla' }));
    expect(fixture.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(fixture.consumeResetCredit).toHaveBeenCalledWith({
      providerId: 'codex',
      creditId: 'credit-1',
    });
  });
});
