import { describe, expect, it } from 'vitest';
import {
  parseDeviceList,
  runtimeLabel,
  SimulatorService,
  validateAppPathShape,
  validateBundleId,
  validateOpenUrl,
  validateUdid,
  type SimctlRunner,
} from './simctl';

const UDID = 'F2F4E5BE-ABCA-4AF2-8426-A62258DD6EEB';

function recorder(stdout: string | Buffer = '') {
  const calls: string[][] = [];
  const run: SimctlRunner = async (argv) => {
    calls.push([...argv]);
    return { stdout: Buffer.from(stdout), stderr: '' };
  };
  return { calls, run };
}

const listJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
      { udid: UDID, name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
      {
        udid: '2869AB30-816D-4BB8-8180-9D6385D97AE6',
        name: 'iPhone 16 Pro',
        state: 'Booted',
        isAvailable: true,
      },
      {
        udid: '952A08FB-CD25-4633-BAF5-702D63297CB2',
        name: 'Eski',
        state: 'Shutdown',
        isAvailable: false,
      },
      { udid: 'not-a-udid', name: 'Bozuk', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
      {
        udid: 'ACF0A6B4-B325-481C-9876-6F4A73B2C662',
        name: 'Watch',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
  },
});

describe('doğrulayıcılar', () => {
  it('yalnızca UDID biçimini kabul eder', () => {
    expect(validateUdid(UDID.toLowerCase())).toEqual({ success: true, data: UDID });
    for (const bad of ['booted', '--help', `${UDID} x`, '', `${UDID}\n`, 'a; rm -rf /']) {
      expect(validateUdid(bad).success).toBe(false);
    }
  });

  it('paket kimliğinde bayrak ve özel karakterleri reddeder', () => {
    expect(validateBundleId('com.example.App-1').success).toBe(true);
    for (const bad of ['-x', '', 'a b', 'a;b', '$(id)', '../x']) {
      expect(validateBundleId(bad).success).toBe(false);
    }
  });

  it('URL şemasını ve boşlukları denetler', () => {
    expect(validateOpenUrl('https://example.com/a?b=1').success).toBe(true);
    expect(validateOpenUrl('myapp://deep/link').success).toBe(true);
    for (const bad of [
      '',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://a b',
      'localhost',
      '-h',
    ]) {
      expect(validateOpenUrl(bad).success).toBe(false);
    }
  });

  it('.app yolunu mutlak ve normalleştirilmiş ister', () => {
    expect(validateAppPathShape('/tmp/Build/My.app').success).toBe(true);
    expect(validateAppPathShape('/tmp/Build/My.app/').success).toBe(true);
    for (const bad of [
      'My.app',
      '/tmp/../etc/My.app',
      '/tmp/x.txt',
      '/tmp//x.app',
      '/tmp/x.app\0',
    ]) {
      expect(validateAppPathShape(bad).success).toBe(false);
    }
  });
});

describe('parseDeviceList', () => {
  it('yalnızca kullanılabilir iOS cihazlarını, açık olanlar önde döndürür', () => {
    const result = parseDeviceList(listJson);
    expect(result.success && result.data.map((d) => [d.name, d.state, d.runtime])).toEqual([
      ['iPhone 16 Pro', 'booted', 'iOS 18.2'],
      ['iPhone 16', 'shutdown', 'iOS 18.2'],
    ]);
  });

  it('bozuk JSON için hata döndürür', () => {
    expect(parseDeviceList('{').success).toBe(false);
    expect(parseDeviceList('{}').success).toBe(false);
  });

  it('çalışma zamanı adını okunur hâle getirir', () => {
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-17-5')).toBe('iOS 17.5');
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.tvOS-17-5')).toBeNull();
  });
});

describe('SimulatorService', () => {
  it('komutları argv dizisi olarak çalıştırır', async () => {
    const { calls, run } = recorder(listJson);
    const service = new SimulatorService({ run, platform: 'darwin' });
    await service.listDevices();
    await service.bootDevice(UDID);
    await service.shutdownDevice(UDID);
    await service.openUrl(UDID, 'https://example.com');
    await service.launchApp(UDID, 'com.example.App');
    await service.setAppearance(UDID, 'dark');
    expect(calls).toEqual([
      ['simctl', 'list', 'devices', '--json'],
      ['simctl', 'boot', UDID],
      ['simctl', 'shutdown', UDID],
      ['simctl', 'openurl', UDID, 'https://example.com'],
      ['simctl', 'launch', UDID, 'com.example.App'],
      ['simctl', 'ui', UDID, 'appearance', 'dark'],
    ]);
  });

  it('geçersiz girdide süreci hiç başlatmaz', async () => {
    const { calls, run } = recorder();
    const service = new SimulatorService({ run, platform: 'darwin' });
    const results = await Promise.all([
      service.bootDevice('booted'),
      service.openUrl(UDID, 'javascript:1'),
      service.launchApp(UDID, '-evil'),
      service.installApp(UDID, 'relative.app'),
      service.screenshot('x'),
    ]);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('macOS dışında "unsupported" döner ve süreç başlatmaz', async () => {
    const { calls, run } = recorder();
    const service = new SimulatorService({ run, platform: 'linux' });
    expect(service.supported).toBe(false);
    const result = await service.listDevices();
    expect(result).toMatchObject({ success: false, error: { type: 'unsupported' } });
    expect(calls).toEqual([]);
  });

  it('ekran görüntüsünü base64 JPEG olarak döndürür, JPEG olmayan çıktıyı reddeder', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const good = recorder(jpeg);
    const ok = await new SimulatorService({ run: good.run, platform: 'darwin' }).screenshot(UDID);
    expect(ok).toEqual({
      success: true,
      data: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    });
    expect(good.calls[0]).toEqual(['simctl', 'io', UDID, 'screenshot', '--type=jpeg', '-']);
    const bad = recorder('Wrote screenshot');
    const failed = await new SimulatorService({ run: bad.run, platform: 'darwin' }).screenshot(
      UDID
    );
    expect(failed.success).toBe(false);
  });

  it('zaten açık cihazı başlatmayı hata saymaz', async () => {
    const run: SimctlRunner = async () => {
      throw new Error('Unable to boot device in current state: Booted');
    };
    const service = new SimulatorService({ run, platform: 'darwin' });
    expect(await service.bootDevice(UDID)).toEqual({ success: true, data: undefined });
  });

  it('simctl hatasını ilk satıra indirger', async () => {
    const run: SimctlRunner = async () => {
      throw new Error('\nInvalid device: X\nusage: simctl ...');
    };
    const result = await new SimulatorService({ run, platform: 'darwin' }).openUrl(
      UDID,
      'https://a.co'
    );
    expect(result).toEqual({
      success: false,
      error: { type: 'simctl_failed', message: 'Invalid device: X' },
    });
  });

  it('.app kurulumunda paket doğrulamasını uygular ve gerçek yolu kullanır', async () => {
    const { calls, run } = recorder();
    const service = new SimulatorService({
      run,
      platform: 'darwin',
      inspectApp: async (path) => ({
        realPath: path.includes('Link') ? '/real/Target.app' : path,
        isDirectory: !path.includes('File'),
        hasInfoPlist: !path.includes('NoPlist'),
      }),
    });
    expect((await service.installApp(UDID, '/b/File.app')).success).toBe(false);
    expect((await service.installApp(UDID, '/b/NoPlist.app')).success).toBe(false);
    expect((await service.installApp(UDID, '/b/Link.app')).success).toBe(true);
    expect(calls).toEqual([['simctl', 'install', UDID, '/real/Target.app']]);
  });
});
