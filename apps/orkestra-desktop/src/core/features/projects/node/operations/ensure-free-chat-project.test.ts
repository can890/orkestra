import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FREE_CHAT_PROJECT_ID, type LocalProject } from '@core/primitives/projects/api';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProjectById: vi.fn(),
  getProjectByPath: vi.fn(),
}));

vi.mock('./create-project', () => ({
  createProject: mocks.createProject,
}));

vi.mock('./getProjects', () => ({
  getProjectById: mocks.getProjectById,
  getProjectByPath: mocks.getProjectByPath,
}));

import { ensureFreeChatProject } from './ensure-free-chat-project';

function sampleProject(path: string): LocalProject {
  return {
    type: 'local',
    id: FREE_CHAT_PROJECT_ID,
    name: 'Sohbetler',
    path,
    baseRef: null,
    repositoryWorkspaceId: 'ws-free-chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ensureFreeChatProject', () => {
  let tempRoot: string;
  const fakeDeps = { db: {} as never, runtimes: {} as never };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'orkestra-free-chat-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('klası oluşturur ve git deposu olmadan dahili serbest sohbet projesini yaratır', async () => {
    const targetDir = join(tempRoot, 'free-chats');
    const created = sampleProject(targetDir);
    mocks.getProjectById.mockResolvedValueOnce(undefined);
    mocks.getProjectByPath.mockResolvedValueOnce(undefined);
    mocks.createProject.mockResolvedValueOnce(ok(created));

    const res = await ensureFreeChatProject(fakeDeps, targetDir);

    expect(res).toEqual(ok(created));
    expect((await stat(targetDir)).isDirectory()).toBe(true);
    expect(mocks.createProject).toHaveBeenCalledWith(fakeDeps, {
      id: FREE_CHAT_PROJECT_ID,
      type: 'local',
      name: 'Sohbetler',
      path: targetDir,
      initGitRepository: false,
    });
  });

  it('tekrar çağrıda mevcut dahili projeyi yeniden kullanır', async () => {
    const targetDir = join(tempRoot, 'free-chats');
    const existing = sampleProject(targetDir);
    mocks.getProjectById.mockResolvedValueOnce(existing);

    const res = await ensureFreeChatProject(fakeDeps, targetDir);

    expect(res).toEqual(ok(existing));
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('kimlik bulunmazsa aynı dizindeki projeyi döndürür', async () => {
    const targetDir = join(tempRoot, 'free-chats');
    const existing = sampleProject(targetDir);
    mocks.getProjectById.mockResolvedValueOnce(undefined);
    mocks.getProjectByPath.mockResolvedValueOnce(existing);

    const res = await ensureFreeChatProject(fakeDeps, targetDir);

    expect(res).toEqual(ok(existing));
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
