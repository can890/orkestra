import { describe, expect, it, vi } from 'vitest';
import {
  isAdHocRequirement,
  parseDesignatedRequirement,
  readDesignatedRequirement,
  UpdateRefusedError,
  verifyCandidateSignature,
  type ExecFile,
} from './code-signature';

const STABLE_DR =
  'identifier "com.orkestra.stable" and certificate leaf = H"119df61cb690b67ea932f6cefccee19c6a4197b2"';
const OTHER_DR =
  'identifier "com.orkestra.stable" and certificate leaf = H"0000000000000000000000000000000000000000"';
const CANDIDATE = '/tmp/update/extracted/Orkestra.app';

type Behaviour = {
  verifyFails?: boolean;
  requirementFails?: boolean;
  candidateRequirement?: string;
  bundleId?: string;
  version?: string;
};

function fakeExec(behaviour: Behaviour = {}) {
  return vi.fn<ExecFile>(async (file, args) => {
    if (file === '/usr/bin/codesign' && args[0] === '-d') {
      return {
        stdout: `designated => ${behaviour.candidateRequirement ?? STABLE_DR}\n`,
        stderr: `Executable=${CANDIDATE}/Contents/MacOS/Orkestra\n`,
      };
    }
    if (file === '/usr/bin/codesign' && args.includes('-R')) {
      if (behaviour.requirementFails) {
        throw Object.assign(new Error('exit 3'), {
          stderr: 'test-requirement: code failed to satisfy specified code requirement(s)',
        });
      }
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/codesign' && args[0] === '--verify') {
      if (behaviour.verifyFails) {
        throw Object.assign(new Error('exit 1'), { stderr: 'a sealed resource is missing' });
      }
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/plutil') {
      if (args[1] === 'CFBundleIdentifier') {
        return { stdout: `${behaviour.bundleId ?? 'com.orkestra.stable'}\n`, stderr: '' };
      }
      return { stdout: `${behaviour.version ?? '1.2.22'}\n`, stderr: '' };
    }
    throw new Error(`unexpected ${file} ${args.join(' ')}`);
  });
}

const input = {
  candidateApp: CANDIDATE,
  runningRequirement: STABLE_DR,
  runningBundleId: 'com.orkestra.stable',
  expectedVersion: '1.2.22',
};

describe('designated requirement parsing', () => {
  it('extracts the designated line from codesign output', () => {
    expect(
      parseDesignatedRequirement(
        `Executable=/Applications/Orkestra.app\ndesignated => ${STABLE_DR}\n`
      )
    ).toBe(STABLE_DR);
    expect(parseDesignatedRequirement('Executable=/x')).toBeNull();
  });

  it('recognises ad-hoc requirements', () => {
    expect(isAdHocRequirement('cdhash H"8f2a"')).toBe(true);
    expect(isAdHocRequirement(STABLE_DR)).toBe(false);
  });

  it('reads the requirement from stdout or stderr', async () => {
    await expect(readDesignatedRequirement(fakeExec(), '/Applications/Orkestra.app')).resolves.toBe(
      STABLE_DR
    );
    const exec = vi.fn<ExecFile>(async () => ({ stdout: '', stderr: 'no signature' }));
    await expect(readDesignatedRequirement(exec, '/x.app')).rejects.toBeInstanceOf(
      UpdateRefusedError
    );
  });
});

describe('verifyCandidateSignature', () => {
  it('accepts a candidate with the same identity, satisfied requirement and version', async () => {
    const exec = fakeExec();
    await expect(verifyCandidateSignature(exec, input)).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', CANDIDATE],
      expect.anything()
    );
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '-R', `=${STABLE_DR}`, CANDIDATE],
      expect.anything()
    );
  });

  it.each<[string, Behaviour, string]>([
    ['a broken signature', { verifyFails: true }, 'kod imzası geçersiz'],
    [
      'a different designated requirement',
      { candidateRequirement: OTHER_DR },
      'aynı imza kimliğini',
    ],
    ['an unsatisfied requirement', { requirementFails: true }, 'gereksinimini karşılamıyor'],
    ['another bundle identifier', { bundleId: 'com.evil.app' }, 'kimliği (com.evil.app)'],
    ['an unexpected version', { version: '1.2.20' }, '1.2.20 sürümünü taşıyor'],
  ])('refuses %s', async (_name, behaviour, message) => {
    const error = await verifyCandidateSignature(fakeExec(behaviour), input).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(UpdateRefusedError);
    expect((error as Error).message).toContain(message);
  });

  it('refuses everything when the running app is ad-hoc signed', async () => {
    const exec = fakeExec();
    await expect(
      verifyCandidateSignature(exec, { ...input, runningRequirement: 'cdhash H"abcd"' })
    ).rejects.toThrow('ad-hoc');
    expect(exec).not.toHaveBeenCalled();
  });
});
