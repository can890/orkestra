import { describe, expect, it } from 'vitest';
import {
  agentBrowserProfileSelection,
  BROWSER_AGENT_PROFILE_ID,
  BROWSER_AGENT_PROFILE_PARTITION,
  BROWSER_PROFILE_PARTITION,
  BROWSER_ISOLATED_PROFILE_ID,
  browserPartitionForProfile,
  browserProfileLabel,
  DEFAULT_BROWSER_PROFILE_ID,
  isNamedBrowserProfileId,
  createBrowserSessionSnapshot,
  isBrowsingDataKind,
  makeIsolatedBrowserPartition,
  makeBrowserSessionIdentity,
  normalizeBrowserProfileSelection,
  normalizeBrowserUrl,
} from './browser';

describe('normalizeBrowserUrl', () => {
  it('defaults localhost-like inputs to http', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toEqual({
      ok: true,
      url: 'http://localhost:5173/',
      protocol: 'http:',
    });
    expect(normalizeBrowserUrl('127.0.0.1:3000/app')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3000/app',
      protocol: 'http:',
    });
  });

  it('defaults public domains to https', () => {
    expect(normalizeBrowserUrl('example.com/path')).toEqual({
      ok: true,
      url: 'https://example.com/path',
      protocol: 'https:',
    });
  });

  it('uses Google search for non-URL input', () => {
    expect(normalizeBrowserUrl('react compiler')).toEqual({
      ok: true,
      url: 'https://www.google.com/search?q=react+compiler',
      protocol: 'https:',
    });
    expect(normalizeBrowserUrl('vitest')).toEqual({
      ok: true,
      url: 'https://www.google.com/search?q=vitest',
      protocol: 'https:',
    });
    expect(normalizeBrowserUrl('react: useState')).toEqual({
      ok: true,
      url: 'https://www.google.com/search?q=react%3A+useState',
      protocol: 'https:',
    });
  });

  it('can reject search-like inputs when validating actual navigation URLs', () => {
    expect(normalizeBrowserUrl('react: useState', { allowSearchQueries: false })).toEqual({
      ok: false,
      reason: 'unsupported-protocol',
    });
    expect(normalizeBrowserUrl('mailto: user@example.com', { allowSearchQueries: false })).toEqual({
      ok: false,
      reason: 'unsupported-protocol',
    });
  });

  it('allows about blank and blocks unsupported protocols', () => {
    expect(normalizeBrowserUrl('about:blank')).toEqual({
      ok: true,
      url: 'about:blank',
      protocol: 'about:',
    });
    expect(normalizeBrowserUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'unsupported-protocol',
    });
    expect(normalizeBrowserUrl('data:text/html,hello')).toEqual({
      ok: false,
      reason: 'unsupported-protocol',
    });
  });

  it('blocks file URLs unless explicitly allowed', () => {
    expect(normalizeBrowserUrl('file:///tmp/index.html')).toEqual({
      ok: false,
      reason: 'unsupported-file-url',
    });
    expect(normalizeBrowserUrl('file:///tmp/index.html', { allowFileUrls: true })).toEqual({
      ok: true,
      url: 'file:///tmp/index.html',
      protocol: 'file:',
    });
  });
});

describe('isBrowsingDataKind', () => {
  it('accepts every supported browsing data category', () => {
    for (const kind of ['all', 'cookies', 'siteData', 'cache']) {
      expect(isBrowsingDataKind(kind)).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(isBrowsingDataKind('storage')).toBe(false);
    expect(isBrowsingDataKind('history')).toBe(false);
    expect(isBrowsingDataKind('downloads')).toBe(false);
    expect(isBrowsingDataKind('')).toBe(false);
  });
});

describe('browser profile selection', () => {
  it('falls back to the first available profile when default was deleted', () => {
    expect(
      normalizeBrowserProfileSelection('missing', [
        { id: 'personal', name: 'Personal' },
        { id: 'work', name: 'Work' },
      ])
    ).toBe('personal');
  });
});

describe('agent browser profile', () => {
  const profiles = [
    { id: 'personal', name: 'Personal' },
    { id: 'work', name: 'Work' },
  ];

  it('follows the default profile unless a separate agent profile is chosen', () => {
    expect(agentBrowserProfileSelection(undefined)).toBe(DEFAULT_BROWSER_PROFILE_ID);
    expect(
      agentBrowserProfileSelection({ agentProfile: 'default', defaultProfileId: 'work', profiles })
    ).toBe('work');
    expect(
      agentBrowserProfileSelection({ agentProfile: 'agent', defaultProfileId: 'work', profiles })
    ).toBe(BROWSER_AGENT_PROFILE_ID);
    expect(
      agentBrowserProfileSelection({ agentProfile: 'isolated', defaultProfileId: 'work', profiles })
    ).toBe(BROWSER_ISOLATED_PROFILE_ID);
  });

  it('keeps the agent profile on its own partition that user profiles cannot claim', () => {
    const identity = makeBrowserSessionIdentity({
      browserId: 'b',
      projectId: 'p',
      workspaceId: 'w',
      taskId: 't',
    });
    expect(normalizeBrowserProfileSelection(BROWSER_AGENT_PROFILE_ID, profiles)).toBe(
      BROWSER_AGENT_PROFILE_ID
    );
    expect(browserPartitionForProfile(identity, BROWSER_AGENT_PROFILE_ID)).toBe(
      'persist:orkestra-browser-agent'
    );
    expect(BROWSER_AGENT_PROFILE_PARTITION).toBe('persist:orkestra-browser-agent');
    expect(isNamedBrowserProfileId(BROWSER_AGENT_PROFILE_ID)).toBe(false);
    expect(browserProfileLabel(BROWSER_AGENT_PROFILE_ID, profiles)).toBe('Ajan');
  });
});

describe('browser session identity', () => {
  it('assigns the default persistent profile partition to new sessions', () => {
    const identity = makeBrowserSessionIdentity({
      browserId: 'Browser One',
      projectId: 'Project/One',
      workspaceId: 'Workspace.One',
      taskId: 'Task One',
    });

    expect(BROWSER_PROFILE_PARTITION).toBe('persist:orkestra-browser-profile');
    expect(createBrowserSessionSnapshot({ identity, now: 100 }).partition).toBe(
      BROWSER_PROFILE_PARTITION
    );
  });

  it('can assign an isolated persistent task partition', () => {
    const identity = makeBrowserSessionIdentity({
      browserId: 'Browser One',
      projectId: 'Project/One',
      workspaceId: 'Workspace.One',
      taskId: 'Task One',
    });

    expect(makeIsolatedBrowserPartition(identity)).toBe(
      'persist:orkestra-browser-isolated-Project_One-Workspace_One-Task_One'
    );
    expect(
      createBrowserSessionSnapshot({
        identity,
        profileId: BROWSER_ISOLATED_PROFILE_ID,
        now: 100,
      })
    ).toMatchObject({
      profileId: BROWSER_ISOLATED_PROFILE_ID,
      partition: 'persist:orkestra-browser-isolated-Project_One-Workspace_One-Task_One',
    });
  });

  it('creates safe snapshots with normalized URLs', () => {
    const identity = makeBrowserSessionIdentity({
      browserId: 'browser-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
    });

    expect(
      createBrowserSessionSnapshot({
        identity,
        currentUrl: 'javascript:alert(1)',
        now: 100,
      })
    ).toMatchObject({
      browserId: 'browser-1',
      currentUrl: 'about:blank',
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('preserves bare host URLs in snapshots', () => {
    const identity = makeBrowserSessionIdentity({
      browserId: 'browser-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
    });

    expect(
      createBrowserSessionSnapshot({
        identity,
        currentUrl: 'intranet',
        now: 100,
      })
    ).toMatchObject({
      currentUrl: 'https://intranet/',
    });
  });
});
