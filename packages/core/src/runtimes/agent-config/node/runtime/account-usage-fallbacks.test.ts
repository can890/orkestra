import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountUsage, readAccountUsage } from './account-usage';
import {
  claudeCredentialInfo,
  claudeGlobalConfigPath,
  latestCodexRateLimits,
  parseClaudeUsageCache,
  parseCodexRateLimitLine,
  readCodexSessionRateLimits,
} from './account-usage-fallbacks';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const json = async (name: string) => JSON.parse(await readFile(fixture(name), 'utf8'));

describe('account usage sources (fixtures)', () => {
  it('parses the Claude OAuth usage response, ignoring non-subscription buckets', async () => {
    const usage = parseAccountUsage('claude', await json('claude-oauth-usage.json'));
    expect(usage.status).toBe('available');
    expect(usage.windows).toEqual([
      { label: '5 saatlik kota', remainingPercent: 88, resetsAt: '2026-10-06T05:19:59.715Z' },
      { label: 'Haftalık kota', remainingPercent: 2, resetsAt: '2026-10-09T08:59:59.715Z' },
    ]);
    expect(usage.balances).toEqual([]);
  });

  it('parses the Codex app-server rate limits with the plan and without duplicates', async () => {
    const usage = parseAccountUsage('codex', await json('codex-rate-limits.json'));
    expect(usage.plan).toBe('pro');
    expect(usage.windows).toEqual([
      { label: 'codex · Haftalık', remainingPercent: 18, resetsAt: '2026-10-09T21:43:58.000Z' },
    ]);
  });

  it('reads the Claude Code /usage cache with its own measurement time', async () => {
    const cache = parseClaudeUsageCache(await json('claude-global-config.json'));
    expect(cache?.measuredAt).toBe('2026-10-05T20:27:28.703Z');
    const usage = parseAccountUsage('claude', cache!.utilization);
    expect(usage.windows.map((window) => window.remainingPercent)).toEqual([100, 2]);
    expect(parseClaudeUsageCache({ cachedUsageUtilization: { utilization: {} } })).toBeNull();
    expect(parseClaudeUsageCache(null)).toBeNull();
  });

  it('extracts token expiry and plan from Claude credentials', () => {
    const credentials = {
      claudeAiOauth: { accessToken: 'secret', expiresAt: 1_000, subscriptionType: 'max' },
    };
    expect(claudeCredentialInfo(credentials, 2_000)).toEqual({
      token: 'secret',
      expired: true,
      plan: 'max',
    });
    expect(claudeCredentialInfo(credentials, 500).expired).toBe(false);
    expect(claudeCredentialInfo({})).toEqual({ token: undefined, expired: false, plan: undefined });
  });

  it('resolves the Claude global config next to CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeGlobalConfigPath({}, '/home/u')).toBe(join('/home/u', '.claude.json'));
    expect(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe(
      join('/cfg', '.claude.json')
    );
  });

  it('keeps the newest core Codex measurement and survives a malformed trailing line', async () => {
    const text = await readFile(fixture('codex-session.jsonl'), 'utf8');
    const latest = latestCodexRateLimits(text);
    expect(latest?.measuredAt).toBe('2026-10-05T23:20:56.250Z');
    const usage = parseAccountUsage('codex', latest!.payload);
    expect(usage.plan).toBe('plus');
    expect(usage.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ['codex · 5 saatlik', 45],
      ['codex · Haftalık', 20],
    ]);
  });

  it('rejects undated, foreign-limit and non token_count lines', () => {
    const base = {
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5 } } },
    };
    expect(parseCodexRateLimitLine(JSON.stringify(base))).toBeNull();
    expect(
      parseCodexRateLimitLine(
        JSON.stringify({
          ...base,
          timestamp: '2026-10-05T00:00:00Z',
          payload: { ...base.payload, type: 'other' },
        })
      )
    ).toBeNull();
    expect(
      parseCodexRateLimitLine(
        JSON.stringify({
          ...base,
          timestamp: '2026-10-05T00:00:00Z',
          payload: { ...base.payload, rate_limits: { limit_id: 'other', primary: {} } },
        })
      )
    ).toBeNull();
  });
});

describe('account usage fallbacks on disk', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orkestra-usage-fallback-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('scans the newest Codex session files', async () => {
    const day = join(home, 'sessions', '2026', '10', '05');
    await mkdir(day, { recursive: true });
    await copyFile(
      fixture('codex-session.jsonl'),
      join(day, 'rollout-2026-10-05T18-18-41-a.jsonl')
    );
    await writeFile(join(day, 'rollout-2026-10-04T10-00-00-b.jsonl'), '{"broken":\n');
    const result = await readCodexSessionRateLimits(home);
    expect(result?.measuredAt).toBe('2026-10-05T23:20:56.250Z');
    expect(await readCodexSessionRateLimits(join(home, 'missing'))).toBeNull();
  });

  it('falls back to Codex session logs when the CLI is unavailable', async () => {
    const day = join(home, '.codex', 'sessions', '2026', '10', '05');
    await mkdir(day, { recursive: true });
    await copyFile(
      fixture('codex-session.jsonl'),
      join(day, 'rollout-2026-10-05T18-18-41-a.jsonl')
    );
    const usage = await readAccountUsage('codex', undefined, {}, home);
    expect(usage).toMatchObject({
      status: 'available',
      plan: 'plus',
      checkedAt: '2026-10-05T23:20:56.250Z',
      source: 'Codex oturum günlükleri',
    });
    expect(usage.message).toContain('Codex CLI bulunamadı');
  });

  it('falls back to the Claude Code /usage cache when the token is expired, without leaking it', async () => {
    const config = join(home, 'claude-config');
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'do-not-leak', expiresAt: 1, subscriptionType: 'max' },
      })
    );
    await copyFile(fixture('claude-global-config.json'), join(config, '.claude.json'));
    const usage = await readAccountUsage('claude', undefined, { CLAUDE_CONFIG_DIR: config }, home);
    expect(usage).toMatchObject({
      status: 'available',
      plan: 'max',
      checkedAt: '2026-10-05T20:27:28.703Z',
      source: 'Claude Code yerel önbelleği (/usage)',
    });
    expect(usage.windows).toHaveLength(2);
    expect(JSON.stringify(usage)).not.toContain('do-not-leak');
    expect(JSON.stringify(usage)).not.toContain(home);
  });

  it('still reports missing credentials when there is no cache either', async () => {
    const usage = await readAccountUsage(
      'claude',
      undefined,
      { CLAUDE_CONFIG_DIR: join(home, 'none') },
      home
    );
    expect(usage.status).toBe('auth-required');
    expect(usage.windows).toEqual([]);
  });
});
