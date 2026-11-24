import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_ROUTING_SOURCE,
  type ProviderHeadroomSample,
  type RouteInput,
  type SubagentRoutingPolicy,
} from '#runtimes/acp/api/subagent-routing';
import { SUBAGENTS_MCP_BRIDGE_SOURCE } from './builtin-subagents-mcp';
import { createSubagentRouter } from './subagent-router';
import { resolveSubagentRoutingFile } from './subagent-routing-file';

const router = createSubagentRouter();
const NOW = Date.UTC(2026, 10, 24, 18, 0, 0);
const RESET = new Date(NOW + 2 * 3600_000).toISOString();
const MEASURED = new Date(NOW - 60_000).toISOString();

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function policy(overrides: Partial<SubagentRoutingPolicy> = {}): SubagentRoutingPolicy {
  return {
    thresholdPercent: 10,
    avoidParentScarceModels: true,
    scarceModels: ['claude-fable-*', 'claude-mythos-*'],
    tiers: [
      {
        id: 'context',
        label: 'Context gathering',
        enabled: true,
        candidates: [
          { provider: 'codex', model: 'gpt-6-luna', effort: 'medium', enabled: true },
          { provider: 'antigravity', model: 'gemini-3.8-flash-medium', enabled: true },
          { provider: 'claude', model: 'claude-haiku-5-5', enabled: true },
        ],
      },
      {
        id: 'execution',
        label: 'Execution',
        enabled: true,
        candidates: [
          { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high', enabled: true },
          { provider: 'claude', model: 'claude-sonnet-5-5', enabled: true },
          { provider: 'antigravity', model: 'gemini-4-hydrogen-medium', enabled: true },
        ],
      },
      {
        id: 'judgment',
        label: 'Judgment',
        enabled: true,
        candidates: [
          { provider: 'claude', model: 'claude-fable-5-2', enabled: true },
          { provider: 'claude', model: 'claude-opus-5-5', enabled: true },
          { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high', enabled: true },
        ],
      },
    ],
    ...overrides,
  };
}

type State = 'ok' | 'low' | 'exhausted' | 'unknown' | 'stale-ok' | 'stale-exhausted' | 'reset';

function sample(state: State): ProviderHeadroomSample | undefined {
  const base = { windowLabel: '5-hour', resetsAt: RESET, measuredAt: MEASURED };
  switch (state) {
    case 'ok':
      return { ...base, remainingPercent: 60 };
    case 'low':
      return { ...base, remainingPercent: 3 };
    case 'exhausted':
      return { ...base, remainingPercent: 0 };
    case 'unknown':
      return undefined;
    case 'stale-ok':
      return {
        ...base,
        remainingPercent: 70,
        measuredAt: new Date(NOW - 3 * 3600_000).toISOString(),
      };
    case 'stale-exhausted':
      return {
        ...base,
        remainingPercent: 0,
        measuredAt: new Date(NOW - 3 * 3600_000).toISOString(),
      };
    case 'reset':
      return { ...base, remainingPercent: 0, resetsAt: new Date(NOW - 60_000).toISOString() };
  }
}

function headroom(states: Partial<Record<string, State>>): Record<string, ProviderHeadroomSample> {
  const out: Record<string, ProviderHeadroomSample> = {};
  for (const [provider, state] of Object.entries(states)) {
    const value = sample(state!);
    if (value) out[provider] = value;
  }
  return out;
}

function decide(input: Partial<RouteInput> & Pick<RouteInput, 'request'>) {
  return router.decideSubagentRoute({
    parent: {},
    policy: policy(),
    headroom: {},
    now: NOW,
    ...input,
  });
}

const explicitAstra = {
  provider: 'codex',
  model: 'gpt-6.2-astra',
  explicitModel: true,
} as const;

describe('classifyHeadroom', () => {
  it.each([
    ['ok', 'ok'],
    ['low', 'low'],
    ['exhausted', 'exhausted'],
    ['unknown', 'unknown'],
    ['stale-ok', 'unknown'],
    ['stale-exhausted', 'exhausted'],
    ['reset', 'unknown'],
  ] as const)('%s sample is classified as %s', (input, expected) => {
    expect(router.classifyHeadroom(sample(input), 10, NOW).state).toBe(expected);
  });

  it('uses the configurable threshold', () => {
    const fifteen = {
      remainingPercent: 15,
      windowLabel: 'w',
      resetsAt: RESET,
      measuredAt: MEASURED,
    };
    expect(router.classifyHeadroom(fifteen, 10, NOW).state).toBe('ok');
    expect(router.classifyHeadroom(fifteen, 20, NOW).state).toBe('low');
  });
});

describe('isScarceModel', () => {
  it('matches glob patterns case-insensitively', () => {
    expect(router.isScarceModel('Claude-Fable-5-2', ['claude-fable-*'])).toBe(true);
    expect(router.isScarceModel('claude-opus-5-5', ['claude-fable-*'])).toBe(false);
    expect(router.isScarceModel('gpt-6.2-sol', ['gpt-6.2-sol'])).toBe(true);
    expect(router.isScarceModel('gpt-6x2-sol', ['gpt-6.2-sol'])).toBe(false);
  });
});

describe('decideSubagentRoute — explicit model', () => {
  // Matris: istenen sağlayıcının durumu × alternatiflerin durumu.
  const matrix: Array<{
    name: string;
    states: Partial<Record<string, State>>;
    action: string;
    target: string | null;
  }> = [
    { name: 'requested ok', states: { codex: 'ok', claude: 'ok' }, action: 'keep', target: null },
    { name: 'requested unknown', states: { claude: 'ok' }, action: 'keep', target: null },
    { name: 'requested stale-ok', states: { codex: 'stale-ok' }, action: 'keep', target: null },
    { name: 'requested window reset', states: { codex: 'reset' }, action: 'keep', target: null },
    {
      name: 'requested low → same-tier ok',
      states: { codex: 'low', claude: 'ok', antigravity: 'ok' },
      action: 'reroute',
      target: 'claude/claude-sonnet-5-5',
    },
    {
      name: 'requested exhausted → same-tier ok',
      states: { codex: 'exhausted', claude: 'ok' },
      action: 'reroute',
      target: 'claude/claude-sonnet-5-5',
    },
    {
      name: 'stale exhaustion still proves saturation',
      states: { codex: 'stale-exhausted', claude: 'ok' },
      action: 'reroute',
      target: 'claude/claude-sonnet-5-5',
    },
    {
      name: 'first same-tier alternative low → next one',
      states: { codex: 'low', claude: 'low', antigravity: 'ok' },
      action: 'reroute',
      target: 'antigravity/gemini-4-hydrogen-medium',
    },
    {
      name: 'ok is preferred over unknown',
      states: { codex: 'low', claude: 'unknown', antigravity: 'ok' },
      action: 'reroute',
      target: 'antigravity/gemini-4-hydrogen-medium',
    },
    {
      name: 'unknown is used when nothing is ok',
      states: { codex: 'low', claude: 'unknown', antigravity: 'exhausted' },
      action: 'reroute',
      target: 'claude/claude-sonnet-5-5',
    },
    {
      name: 'everything exhausted → kept with a note',
      states: { codex: 'exhausted', claude: 'exhausted', antigravity: 'exhausted' },
      action: 'no-alternative',
      target: null,
    },
  ];

  it.each(matrix)('$name', ({ states, action, target }) => {
    const decision = decide({ request: explicitAstra, headroom: headroom(states) });
    expect(decision.action).toBe(action);
    if (target) expect(`${decision.provider}/${decision.model}`).toBe(target);
    else {
      expect(decision.provider).toBe('codex');
      expect(decision.model).toBe('gpt-6.2-astra');
    }
    if (action === 'keep') expect(decision.note).toBeNull();
    else expect(decision.note).toBeTruthy();
  });

  it('explains the reroute with usage percentage, window and reset time', () => {
    const decision = decide({
      request: explicitAstra,
      headroom: {
        codex: {
          remainingPercent: 3,
          windowLabel: '5-hour',
          resetsAt: RESET,
          measuredAt: MEASURED,
        },
        claude: sample('ok')!,
      },
    });
    expect(decision.note).toBe(
      `requested codex/gpt-6.2-astra, routed to claude/claude-sonnet-5-5 because codex/gpt-6.2-astra is at 97% of its 5-hour window, resets ${hhmm(RESET)}`
    );
    expect(decision.tier).toBe('execution');
    expect(decision.headroom?.state).toBe('ok');
  });

  it('falls back to a cheaper tier but never moves a request up to a scarcer tier', () => {
    const down = decide({
      request: explicitAstra,
      headroom: headroom({ codex: 'low', claude: 'low', antigravity: 'ok' }),
      policy: policy({
        tiers: policy().tiers.map((tier) =>
          tier.id === 'execution'
            ? {
                ...tier,
                candidates: tier.candidates.filter((c) => c.provider !== 'antigravity'),
              }
            : tier
        ),
      }),
    });
    expect(down.action).toBe('reroute');
    expect(`${down.provider}/${down.model}`).toBe('antigravity/gemini-3.8-flash-medium');
    expect(down.tier).toBe('context');

    const neverUp = decide({
      request: { provider: 'codex', model: 'gpt-6-luna', explicitModel: true },
      headroom: headroom({ codex: 'exhausted', antigravity: 'exhausted', claude: 'exhausted' }),
    });
    expect(neverUp.action).toBe('no-alternative');
    expect(neverUp.model).toBe('gpt-6-luna');
  });

  it('keeps models that are not in the policy and says why', () => {
    const decision = decide({
      request: { provider: 'kimi', model: 'kimi-code/k3', explicitModel: true },
      headroom: headroom({ kimi: 'exhausted', claude: 'ok' }),
    });
    expect(decision.action).toBe('no-alternative');
    expect(decision.note).toContain('not in the routing policy');
  });

  it('skips disabled candidates, disabled tiers and providers that are not installed', () => {
    const states = headroom({ codex: 'low', claude: 'ok', antigravity: 'ok' });
    const disabledClaude = policy({
      tiers: policy().tiers.map((tier) => ({
        ...tier,
        candidates: tier.candidates.map((c) =>
          c.provider === 'claude' ? { ...c, enabled: false } : c
        ),
      })),
    });
    expect(
      decide({ request: explicitAstra, headroom: states, policy: disabledClaude }).provider
    ).toBe('antigravity');
    expect(
      decide({ request: explicitAstra, headroom: states, installed: { claude: false } }).provider
    ).toBe('antigravity');
    const executionOff = policy({
      tiers: policy().tiers.map((tier) =>
        tier.id === 'execution' ? { ...tier, enabled: false } : tier
      ),
    });
    // Model artık hiçbir etkin katmanda değil: yönlendirme yapılmaz.
    expect(decide({ request: explicitAstra, headroom: states, policy: executionOff }).action).toBe(
      'no-alternative'
    );
  });

  it('honours the threshold when deciding to reroute', () => {
    const fifteen = {
      codex: { remainingPercent: 15, windowLabel: 'w', resetsAt: RESET, measuredAt: MEASURED },
      claude: sample('ok')!,
    };
    expect(decide({ request: explicitAstra, headroom: fifteen }).action).toBe('keep');
    expect(
      decide({
        request: explicitAstra,
        headroom: fifteen,
        policy: policy({ thresholdPercent: 20 }),
      }).action
    ).toBe('reroute');
  });

  it('lets an explicit request use the parent’s scarce model but never reroutes into it', () => {
    const explicitFable = decide({
      request: { provider: 'claude', model: 'claude-fable-5-2', explicitModel: true },
      parent: { provider: 'claude', model: 'claude-fable-5-2' },
      headroom: headroom({ claude: 'ok' }),
    });
    expect(explicitFable.action).toBe('keep');
    expect(explicitFable.model).toBe('claude-fable-5-2');

    const sol = decide({
      request: { provider: 'codex', model: 'gpt-6.2-sol', explicitModel: true },
      parent: { provider: 'claude' },
      headroom: headroom({ codex: 'exhausted', claude: 'ok' }),
    });
    expect(sol.action).toBe('reroute');
    expect(sol.model).toBe('claude-opus-5-5');
  });
});

describe('decideSubagentRoute — no model requested', () => {
  it('picks the first execution candidate with headroom', () => {
    const decision = decide({
      request: { explicitModel: false },
      headroom: headroom({ codex: 'ok', claude: 'ok' }),
    });
    expect(decision).toMatchObject({
      action: 'pick',
      provider: 'codex',
      model: 'gpt-6.2-astra',
      effort: 'high',
      tier: 'execution',
    });
    expect(decision.note).toContain('picked codex/gpt-6.2-astra from the Execution tier');
  });

  it('uses policy order when there is no usage data at all', () => {
    const decision = decide({ request: { explicitModel: false, tier: 'context' } });
    expect(decision.action).toBe('pick');
    expect(`${decision.provider}/${decision.model}`).toBe('codex/gpt-6-luna');
    expect(decision.headroom?.state).toBe('unknown');
  });

  it('skips exhausted providers and walks down to cheaper tiers only', () => {
    const decision = decide({
      request: { explicitModel: false, tier: 'execution' },
      headroom: headroom({ codex: 'exhausted', claude: 'exhausted', antigravity: 'low' }),
    });
    expect(decision.action).toBe('keep');

    const cheaper = decide({
      request: { explicitModel: false, tier: 'execution' },
      headroom: headroom({ codex: 'exhausted', claude: 'exhausted', antigravity: 'low' }),
      policy: policy({
        tiers: [
          {
            id: 'context',
            label: 'Context gathering',
            enabled: true,
            candidates: [{ provider: 'kimi', model: 'kimi-code/k3', enabled: true }],
          },
          ...policy().tiers.slice(1),
        ],
      }),
    });
    expect(`${cheaper.provider}/${cheaper.model}`).toBe('kimi/kimi-code/k3');
    expect(cheaper.tier).toBe('context');
  });

  it.each([
    { parent: { provider: 'claude' }, avoid: true, expected: 'claude-opus-5-5' },
    {
      parent: { provider: 'claude', model: 'claude-fable-5-2' },
      avoid: true,
      expected: 'claude-opus-5-5',
    },
    {
      parent: { provider: 'claude', model: 'claude-opus-5-5' },
      avoid: true,
      expected: 'claude-fable-5-2',
    },
    { parent: { provider: 'codex' }, avoid: true, expected: 'claude-fable-5-2' },
    { parent: {}, avoid: true, expected: 'claude-fable-5-2' },
    { parent: { provider: 'claude' }, avoid: false, expected: 'claude-fable-5-2' },
  ])(
    'judgment tier with parent $parent (avoid=$avoid) → $expected',
    ({ parent, avoid, expected }) => {
      const decision = decide({
        request: { explicitModel: false, tier: 'judgment' },
        parent,
        policy: policy({ avoidParentScarceModels: avoid }),
        headroom: headroom({ claude: 'ok', codex: 'ok' }),
      });
      expect(decision.model).toBe(expected);
    }
  );

  it('stays within the requested provider while it has headroom, then crosses providers', () => {
    const own = decide({
      request: { provider: 'claude', explicitModel: false },
      headroom: headroom({ claude: 'ok', codex: 'ok' }),
    });
    expect(`${own.provider}/${own.model}`).toBe('claude/claude-sonnet-5-5');

    const crossed = decide({
      request: { provider: 'claude', explicitModel: false },
      headroom: headroom({ claude: 'exhausted', codex: 'ok' }),
    });
    expect(`${crossed.provider}/${crossed.model}`).toBe('codex/gpt-6.2-astra');
    expect(crossed.note).toContain('claude is at 100%');

    const keep = decide({
      request: { provider: 'kimi', explicitModel: false },
      headroom: headroom({ kimi: 'ok' }),
    });
    expect(keep.action).toBe('keep');
    expect(keep.provider).toBe('kimi');
  });

  it('keeps today’s behaviour with an empty policy', () => {
    const decision = decide({
      request: { explicitModel: false },
      policy: policy({ tiers: [] }),
    });
    expect(decision).toMatchObject({ action: 'keep', note: null, provider: null, model: null });
  });
});

describe('annotateSubagentModels', () => {
  it('reports provider headroom and one recommendation per tier', () => {
    const annotation = router.annotateSubagentModels({
      parent: { provider: 'claude' },
      policy: policy(),
      headroom: headroom({ codex: 'low', claude: 'ok', antigravity: 'ok', grok: 'ok' }),
      now: NOW,
    });
    expect(annotation.providers.codex!.state).toBe('low');
    expect(annotation.providers.grok!.state).toBe('ok');
    expect(annotation.recommended.context).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-medium',
    });
    expect(annotation.recommended.execution).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(annotation.recommended.judgment).toMatchObject({ model: 'claude-opus-5-5' });
  });
});

describe('bridge embedding', () => {
  it('embeds exactly the routing source into the MCP bridge', () => {
    expect(SUBAGENTS_MCP_BRIDGE_SOURCE).toContain(SUBAGENT_ROUTING_SOURCE);
  });

  it('resolves the snapshot file next to the sub-agent state directory', () => {
    expect(resolveSubagentRoutingFile({ ORKESTRA_SUBAGENTS_DIR: '/tmp/x/subagents' })).toBe(
      '/tmp/x/subagent-routing.json'
    );
    expect(resolveSubagentRoutingFile({ ORKESTRA_SUBAGENTS_ROUTING_FILE: '/tmp/r.json' })).toBe(
      '/tmp/r.json'
    );
  });
});
