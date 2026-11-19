import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lifecycleHooksContract, lifecycleHooksDomain } from '../api/contract';

/**
 * Kanca tanımları yalnızca kullanıcının Ayarlar sayfasından (renderer → Wire) yazılabilir.
 * Bu testler yapısal olarak şunu korur: ajan araçları, MCP, depo dosyaları ve uzak erişim
 * yüzeyleri kanca yapılandırmasına ne okuma ne yazma yoluyla bağlıdır.
 */
const featuresRoot = path.resolve(__dirname, '../..');
const servicesRoot = path.resolve(__dirname, '../../../services');
const hooksNodeDir = __dirname;

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('kanca yazma yüzeyi', () => {
  it('Wire sözleşmesi dışında yazma yolu yok: yalnızca dört prosedür, hepsi renderer içindir', () => {
    expect(Object.keys(lifecycleHooksContract).sort()).toEqual([
      'clearRuns',
      'getState',
      'listRuns',
      'saveConfig',
    ]);
    expect(lifecycleHooksDomain).toBe('lifecycleHooks');
  });

  it('ajan araç sunucuları ve MCP kaynakları kanca modüllerine/alanına başvurmaz', () => {
    const agentToolSources = [
      ...listFiles(path.join(servicesRoot, 'agent-tools')),
      ...listFiles(path.join(featuresRoot, 'browser/node/agent-tools')),
      ...listFiles(path.join(featuresRoot, 'mcp')),
    ];
    expect(agentToolSources.length).toBeGreaterThan(0);
    for (const file of agentToolSources) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/lifecycle-hooks|lifecycleHooks|hook-config-store/);
    }
  });

  it('konuşma denetleyicisi kancalara yalnızca olay yayınlar (yapılandırma deposuna erişmez)', () => {
    const controller = fs.readFileSync(
      path.join(featuresRoot, 'conversations/node/wire-controller.ts'),
      'utf8'
    );
    const imports = controller.match(/from '@core\/features\/lifecycle-hooks[^']*'/g) ?? [];
    expect(imports).toEqual([
      "from '@core/features/lifecycle-hooks/node/hook-event-bus'",
    ]);
  });

  it('kanca modülleri depo/proje yapılandırmasını ve ajan yüzeylerini içe aktarmaz', () => {
    const forbidden = [
      /\.orkestra\.json/,
      /project-settings/,
      /projectConfig/,
      /getProjectConfig/,
      /agent-tools/,
      /\/mcp\//,
      /plugins/,
    ];
    for (const file of listFiles(hooksNodeDir)) {
      const source = fs
        .readFileSync(file, 'utf8')
        // Açıklama satırlarını yok say: yasak adlar yorumlarda anılabilir.
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      for (const pattern of forbidden) {
        expect(source, `${path.basename(file)} ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('shellSetup yalnızca host ayarlarından çözülür (depo .orkestra.json değil)', () => {
    const controllers = fs.readFileSync(
      path.resolve(__dirname, '../../../manifests/node/controllers.ts'),
      'utf8'
    );
    const block = controllers.slice(controllers.indexOf('lifecycleHooks: {'));
    const section = block.slice(0, block.indexOf('logHealth: {'));
    expect(section).toContain('hostSettingsDefaults');
    expect(section).not.toMatch(/projectConfig|getProjectConfig|orkestra\.json/);
  });
});
