import { describe, expect, it } from 'vitest';
import { resolveDbResetTargets } from './db-reset.ts';

describe('resolveDbResetTargets', () => {
  it('targets the ORKESTRA_DB_FILE family when the override is set', () => {
    const targets = resolveDbResetTargets({
      dbFile: '/tmp/scratch.db',
      platform: 'darwin',
      home: '/Users/dev',
    });

    expect(targets).toContain('/tmp/scratch.db');
    expect(targets).toContain('/tmp/scratch-file-search.db');
    expect(targets).toContain('/tmp/scratch-automations.db');
    expect(targets).toContain('/tmp/scratch-operations.db');
    // Every database file brings its SQLite sidecars along.
    expect(targets).toContain('/tmp/scratch.db-wal');
    expect(targets).toContain('/tmp/scratch.db-shm');
    expect(targets).toContain('/tmp/scratch-file-search.db-wal');
    // The default dev databases are left alone when the override is set.
    expect(targets.some((t) => t.includes('orkestra-dev'))).toBe(false);
  });

  it('derives sibling names for override paths without a .db extension', () => {
    const targets = resolveDbResetTargets({
      dbFile: '/tmp/scratch',
      platform: 'linux',
      home: '/home/dev',
    });

    expect(targets).toContain('/tmp/scratch');
    expect(targets).toContain('/tmp/scratch-file-search.db');
  });

  it('targets the default dev databases in the macOS userData dir', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'darwin',
      home: '/Users/dev',
    });

    const dir = '/Users/dev/Library/Application Support/orkestra-dev';
    expect(targets).toContain(`${dir}/orkestra4.db`);
    expect(targets).toContain(`${dir}/orkestra4-file-search.db`);
    expect(targets).toContain(`${dir}/orkestra4-automations.db`);
    expect(targets).toContain(`${dir}/orkestra4-operations.db`);
    expect(targets).toContain(`${dir}/orkestra3.db`);
    expect(targets).toContain(`${dir}/orkestra4.db-wal`);
    expect(targets).toContain(`${dir}/orkestra4.db-shm`);
  });

  it('targets the default dev databases in the Linux config dir', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'linux',
      home: '/home/dev',
    });

    expect(targets).toContain('/home/dev/.config/orkestra-dev/orkestra4.db');
  });

  it('targets the default dev databases under APPDATA on Windows', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'win32',
      home: 'C:\\Users\\dev',
      appData: 'C:\\Users\\dev\\AppData\\Roaming',
    });

    expect(targets.some((t) => t.includes('orkestra-dev') && t.endsWith('orkestra4.db'))).toBe(
      true
    );
  });
});
