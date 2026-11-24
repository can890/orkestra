import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAcpRegistryDistribution } from '../api/distribution';
import type { AcpRegistryAgent } from '../api/registry-schema';
import {
  AcpInstallError,
  AcpRegistryInstaller,
  downloadVerified,
  type RunCommand,
} from './installer';
import type { FetchLike } from './registry-client';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-acp-install-'));
  dirs.push(dir);
  return dir;
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function binaryAgent(archive: string, digest?: string, cmd = './agent-bin'): AcpRegistryAgent {
  return {
    id: 'demo-agent',
    name: 'Demo',
    version: '1.2.3',
    description: '',
    distribution: {
      binary: {
        'darwin-aarch64': { archive, cmd, args: ['acp'], ...(digest ? { sha256: digest } : {}) },
      },
    },
  };
}

function serve(body: Buffer): FetchLike {
  return vi.fn<FetchLike>(async () => new Response(new Uint8Array(body)));
}

function distributionFor(agent: AcpRegistryAgent) {
  return resolveAcpRegistryDistribution({ agent, platformTarget: 'darwin-aarch64' })!;
}

describe('downloadVerified', () => {
  it('streams to disk and returns the SHA-256 digest', async () => {
    const dir = tempDir();
    const body = Buffer.from('#!/bin/sh\necho hi\n');
    const digest = await downloadVerified(serve(body), 'https://example.com/a', join(dir, 'a'));
    expect(digest).toBe(sha(body));
    expect(readFileSync(join(dir, 'a'))).toEqual(body);
  });

  it('refuses non-HTTPS URLs and oversized downloads', async () => {
    const dir = tempDir();
    await expect(
      downloadVerified(serve(Buffer.from('x')), 'http://example.com/a', join(dir, 'a'))
    ).rejects.toMatchObject({ reason: 'download_failed' });
    await expect(
      downloadVerified(serve(Buffer.alloc(64)), 'https://example.com/a', join(dir, 'b'), 16)
    ).rejects.toMatchObject({ reason: 'archive_invalid' });
  });
});

describe('AcpRegistryInstaller binary', () => {
  it('installs a raw binary whose checksum matches and makes it executable', async () => {
    const toolsDir = tempDir();
    const body = Buffer.from('#!/bin/sh\necho agent\n');
    const agent = binaryAgent('https://example.com/agent-bin', sha(body));
    const installer = new AcpRegistryInstaller({
      toolsDir,
      fetch: serve(body),
      platform: 'darwin',
    });

    const result = await installer.install(agent, distributionFor(agent));

    expect(result.command).toBe(
      join(toolsDir, 'demo-agent', '1.2.3', 'darwin-aarch64', 'agent-bin')
    );
    expect(result.installDir).toBe(join(toolsDir, 'demo-agent', '1.2.3'));
    expect(statSync(result.command).mode & 0o111).not.toBe(0);
    expect(readFileSync(result.command)).toEqual(body);
  });

  it('rejects a checksum mismatch and leaves nothing installed', async () => {
    const toolsDir = tempDir();
    const agent = binaryAgent('https://example.com/agent-bin', sha('something else'));
    const installer = new AcpRegistryInstaller({
      toolsDir,
      fetch: serve(Buffer.from('tampered')),
      platform: 'darwin',
    });

    await expect(installer.install(agent, distributionFor(agent))).rejects.toMatchObject({
      reason: 'checksum_mismatch',
    });
    expect(existsSync(join(toolsDir, 'demo-agent', '1.2.3', 'darwin-aarch64'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('extracts a verified tar.gz archive', async () => {
    const work = tempDir();
    mkdirSync(join(work, 'src', 'bin'), { recursive: true });
    writeFileSync(join(work, 'src', 'bin', 'devin'), '#!/bin/sh\necho devin\n');
    execFileSync('tar', ['-czf', join(work, 'agent.tar.gz'), '-C', join(work, 'src'), '.']);
    const archive = readFileSync(join(work, 'agent.tar.gz'));
    const toolsDir = tempDir();
    const agent = binaryAgent('https://example.com/devin.tar.gz', sha(archive), './bin/devin');
    const installer = new AcpRegistryInstaller({
      toolsDir,
      fetch: serve(archive),
      platform: 'darwin',
    });

    const result = await installer.install(agent, distributionFor(agent));

    expect(result.command).toBe(
      join(toolsDir, 'demo-agent', '1.2.3', 'darwin-aarch64', 'bin', 'devin')
    );
    expect(statSync(result.command).mode & 0o111).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects archives with escaping entries', async () => {
    const run = vi.fn<RunCommand>(async (command, args) => {
      if (args[0] === '-tzf') return { code: 0, stdout: 'bin/devin\n../../escape\n', stderr: '' };
      throw new Error(`unexpected ${command}`);
    });
    const agent = binaryAgent('https://example.com/devin.tar.gz', undefined, './bin/devin');
    const installer = new AcpRegistryInstaller({
      toolsDir: tempDir(),
      fetch: serve(Buffer.from('archive')),
      platform: 'darwin',
      run,
    });
    await expect(installer.install(agent, distributionFor(agent))).rejects.toMatchObject({
      reason: 'archive_invalid',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe command paths before downloading', async () => {
    const fetch = vi.fn<FetchLike>();
    const agent = binaryAgent('https://example.com/a', undefined, '../outside');
    const installer = new AcpRegistryInstaller({ toolsDir: tempDir(), fetch, platform: 'darwin' });
    await expect(installer.install(agent, distributionFor(agent))).rejects.toBeInstanceOf(
      AcpInstallError
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AcpRegistryInstaller npx', () => {
  it('installs the pinned package into an Orkestra-owned prefix and resolves its bin', async () => {
    const toolsDir = tempDir();
    const agent: AcpRegistryAgent = {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '0.71.1',
      description: '',
      distribution: { npx: { package: '@google/gemini-cli@0.71.1', args: ['--acp'] } },
    };
    const run = vi.fn<RunCommand>(async (command, args, options) => {
      expect(command).toBe('npm');
      const prefix = args[args.indexOf('--prefix') + 1]!;
      expect(args.at(-1)).toBe('@google/gemini-cli@0.71.1');
      expect(options.env?.npm_config_prefix).toBeUndefined();
      const pkg = join(prefix, 'lib', 'node_modules', '@google', 'gemini-cli');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: '@google/gemini-cli',
          version: '0.71.1',
          bin: { gemini: 'dist/index.js' },
        })
      );
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      writeFileSync(join(prefix, 'bin', 'gemini'), '#!/usr/bin/env node\n');
      return { code: 0, stdout: '', stderr: '' };
    });
    const installer = new AcpRegistryInstaller({
      toolsDir,
      fetch: vi.fn<FetchLike>(),
      platform: 'darwin',
      run,
      env: async () => ({ PATH: '/usr/bin', npm_config_prefix: '/somewhere/else' }),
    });

    const result = await installer.install(
      agent,
      resolveAcpRegistryDistribution({ agent, platformTarget: 'darwin-aarch64' })!
    );

    expect(result.command).toBe(join(toolsDir, 'gemini', '0.71.1', 'npm', 'bin', 'gemini'));
  });

  it('reports a missing package manager as runner_unavailable', async () => {
    const run = vi.fn<RunCommand>(async () => {
      throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    });
    const agent: AcpRegistryAgent = {
      id: 'x',
      name: 'X',
      version: '1.0.0',
      description: '',
      distribution: { npx: { package: 'x@1.0.0' } },
    };
    const installer = new AcpRegistryInstaller({
      toolsDir: tempDir(),
      fetch: vi.fn<FetchLike>(),
      run,
    });
    await expect(
      installer.install(
        agent,
        resolveAcpRegistryDistribution({ agent, platformTarget: undefined })!
      )
    ).rejects.toMatchObject({ reason: 'runner_unavailable' });
  });
});
