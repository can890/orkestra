import { describe, expect, it } from 'vitest';
import { buildCloneArgs } from './git-clone';

describe('buildCloneArgs', () => {
  it('URL ve hedefi "--" sonrasına koyar ve https dışı protokolleri kapatır', () => {
    const args = buildCloneArgs('https://github.com/a/b.git', '/tmp/hedef');
    const dash = args.indexOf('--');
    expect(args.slice(dash)).toEqual(['--', 'https://github.com/a/b.git', '/tmp/hedef']);
    expect(args).toContain('protocol.allow=never');
    expect(args).toContain('protocol.https.allow=always');
    expect(args).toContain('--no-recurse-submodules');
    expect(args).toContain('--template=');
    expect(args).toContain('--depth');
  });
});
