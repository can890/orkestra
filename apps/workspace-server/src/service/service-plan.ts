// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/cloud/bootService.ts
// (renderBootServiceUnit, renderBootServicePlist, systemdManager, launchdManager).
//
// Arka plan servisinin saf planı: hangi dosyaya ne yazılacağı ve hangi komutların hangi sırayla
// çalışacağı. Burada süreç çalıştırılmaz; komutları `service-cli.ts` enjekte edilen bir runner ile
// yürütür, testler ise üretilen metni ve komut dizilerini birebir doğrular.
import { join } from 'node:path';

export type ServiceTarget = 'server' | 'desktop-host';
export type ServicePlatform = 'systemd' | 'launchd';
export type DesktopDisplay = 'xvfb' | 'existing';

type TargetDefinition = {
  /** systemd birim adı (uzantısız) ve günlük/ortam dosyası adı. */
  name: string;
  launchdLabel: string;
  description: string;
  /**
   * Sunucunun bellek koruması: ajanlar belleği doldururken çekirdek önce onların korunmasız
   * sayfalarını geri alır. Çekirdek bunu `user.slice` korumasıyla sınırlar (yalnızca root verir).
   */
  memoryLow: string;
};

export const SERVICE_TARGETS: Record<ServiceTarget, TargetDefinition> = {
  server: {
    name: 'orkestra-workspace-server',
    launchdLabel: 'com.orkestra.workspace-server',
    description: 'Orkestra workspace server',
    memoryLow: '1536M',
  },
  'desktop-host': {
    name: 'orkestra-desktop-host',
    launchdLabel: 'com.orkestra.desktop-host',
    description: 'Orkestra headless desktop host',
    memoryLow: '1G',
  },
};

/** Servisin `run` başlatıcısının ortam değişkeni; servis içinde çalışıldığını bildirir. */
export const SERVICE_UNIT_ENV = 'ORKESTRA_SERVICE_UNIT';

/** Geçersiz yönetilen politikanın çıkış kodu: systemd bu kodda yeniden başlatmaz. */
export const MANAGED_POLICY_EXIT_CODE = 78;

/**
 * Başsız Electron ana bilgisayarı için Chromium bayrakları. Uygulama `SOVRA_HEADLESS=1` ile
 * donanım hızlandırmayı zaten kapatır; bayraklar GPU sürecinin hiç açılmamasını sağlar
 * (Xvfb üzerinde periyodik SIGTRAP çökmeleri).
 */
export const HEADLESS_ELECTRON_FLAGS = ['--disable-gpu', '--disable-gpu-compositing'] as const;

export type ServicePaths = {
  homeDirectory: string;
  /** `~/.orkestra/service` */
  serviceDirectory: string;
  envFile: string;
  logDirectory: string;
  logFile: string;
  unitFile: string;
};

export function servicePaths(
  target: ServiceTarget,
  platform: ServicePlatform,
  homeDirectory: string,
  xdgConfigHome?: string
): ServicePaths {
  const definition = SERVICE_TARGETS[target];
  const serviceDirectory = join(homeDirectory, '.orkestra', 'service');
  const logDirectory = join(serviceDirectory, 'logs');
  const systemdUnitDirectory = join(
    xdgConfigHome && xdgConfigHome.startsWith('/') ? xdgConfigHome : join(homeDirectory, '.config'),
    'systemd',
    'user'
  );
  return {
    homeDirectory,
    serviceDirectory,
    envFile: join(serviceDirectory, `${definition.name}.env`),
    logDirectory,
    logFile: join(logDirectory, `${definition.name}.log`),
    unitFile:
      platform === 'systemd'
        ? join(systemdUnitDirectory, `${definition.name}.service`)
        : join(homeDirectory, 'Library', 'LaunchAgents', `${definition.launchdLabel}.plist`),
  };
}

export type ServicePlanInput = {
  target: ServiceTarget;
  platform: ServicePlatform;
  /** Servisin çalıştıracağı CLI (paketli başlatıcı ya da `node dist/index.mjs`). */
  cliProgram: readonly string[];
  paths: ServicePaths;
  /** `server`: sunucunun dinleyeceği Unix soketi. */
  socketPath?: string;
  /** `desktop-host`: Orkestra uygulamasının çalıştırılabilir dosyası. */
  appPath?: string;
  display?: DesktopDisplay;
  /** `display: xvfb` iken `xvfb-run` yolu. */
  xvfbRunPath?: string;
  /** `desktop-host`: paylaşılan workspace-server soketi (`SOVRA_LOCAL_WORKSPACE_SOCKET`). */
  workspaceSocket?: string;
  /** İsteğe bağlı sert bellek sınırı (systemd `MemoryMax`, örn. `6G`). */
  memoryMax?: string;
};

/** Servis yöneticisinin başlattığı komut: her zaman CLI'nin `service run` başlatıcısı. */
export function serviceProgram(input: ServicePlanInput): string[] {
  const args = [...input.cliProgram, 'service', 'run', '--target', input.target];
  if (input.target === 'server') {
    if (input.socketPath) args.push('--socket', input.socketPath);
    return args;
  }
  if (!input.appPath) throw new Error('desktop-host needs the Orkestra app path (--app)');
  args.push('--app', input.appPath, '--display', input.display ?? 'existing');
  if (input.display === 'xvfb') {
    if (!input.xvfbRunPath) throw new Error('xvfb display needs the xvfb-run path');
    args.push('--xvfb-run', input.xvfbRunPath);
  }
  if (input.workspaceSocket) args.push('--workspace-socket', input.workspaceSocket);
  return args;
}

/** systemd `%` belirteçlerini genişletir; yollarda kaçırılmalıdır. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll('%', '%%');
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : escaped;
}

// systemd tırnak içinde bile tırnak, ters bölü ya da kontrol karakteri içeren bir yürütülebilir
// dosyayı reddeder.
function assertSystemdSafeProgram(program: readonly string[]): void {
  if (/[\x00-\x1f\x7f"'\\]/.test(program[0] ?? '')) {
    throw new Error(
      `systemd cannot run a program whose path contains quotes or control characters: ${program[0]}`
    );
  }
}

/** Servis birimleri kullanıcının kabuğuna ya da PATH'ine güvenemez; her şey mutlak yoldur. */
export function renderSystemdUnit(input: ServicePlanInput): string {
  const definition = SERVICE_TARGETS[input.target];
  const program = serviceProgram(input);
  assertSystemdSafeProgram(program);
  const log = escapeSystemdSpecifiers(input.paths.logFile);
  return [
    '[Unit]',
    `Description=${definition.description}`,
    'Documentation=https://github.com/can890/orkestra',
    // Arka arkaya 5 çöküşten sonra systemd durur; `service restart` durumu temizler.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    ...(input.target === 'desktop-host' && input.workspaceSocket
      ? ['Wants=orkestra-workspace-server.service', 'After=orkestra-workspace-server.service']
      : []),
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quoteSystemdValue(input.paths.homeDirectory)}`,
    `Environment=${SERVICE_UNIT_ENV}=${definition.name}.service`,
    `ExecStart=${program.map(quoteSystemdValue).join(' ')}`,
    // Başlatıcı önce SIGTERM alır ve alt süreci düzgün kapatır; zaman aşımında tüm cgroup öldürülür.
    'KillMode=mixed',
    'TimeoutStopSec=90',
    // Ajanlar aynı cgroup'u paylaşır; varsayılan OOMPolicy=stop, biri OOM ile ölünce birimi durdururdu.
    'OOMPolicy=continue',
    'Restart=always',
    'RestartSec=5',
    // Geçersiz yönetilen politika: yeniden denemek düzeltmez, yöneticinin müdahalesi gerekir.
    `RestartPreventExitStatus=${MANAGED_POLICY_EXIT_CODE}`,
    // Ağırlıklar sunucuyu kardeş süreçlere göre öne alır; IOWeight devredilmiş io denetleyicisi ister.
    'CPUWeight=1000',
    'IOWeight=1000',
    // Bellek geri kazanımı önce ajanların korunmasız sayfalarını alır.
    `MemoryLow=${definition.memoryLow}`,
    ...(input.memoryMax ? [`MemoryMax=${input.memoryMax}`] : []),
    // Kullanıcı yöneticisinin verebileceği en düşük puan: diğer kullanıcı servislerinin (200) altında.
    'OOMScoreAdjust=100',
    // systemd-oomd bu tercihi yalnızca izlenen cgroup kullanıcıya aitse dikkate alır.
    'ManagedOOMPreference=avoid',
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** launchd PATH'i: Homebrew ve sistem dizinleri (ajan CLI'leri kabuk ortamından da çözülür). */
export const LAUNCHD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function renderLaunchdPlist(input: ServicePlanInput): string {
  const definition = SERVICE_TARGETS[input.target];
  const program = serviceProgram(input);
  // ExitTimeOut: düzgün kapanış için 90 sn. Interactive: arka plan kısıtlamasından kaçınır.
  // ThrottleInterval: çöküşte yeniden başlatma aralığı (geri çekilme).
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${definition.launchdLabel}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${LAUNCHD_PATH}</string>`,
    `    <key>${SERVICE_UNIT_ENV}</key>`,
    `    <string>${definition.launchdLabel}</string>`,
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXmlText(input.paths.homeDirectory)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>ExitTimeOut</key>',
    '  <integer>90</integer>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXmlText(input.paths.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXmlText(input.paths.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderServiceUnit(input: ServicePlanInput): string {
  return input.platform === 'systemd' ? renderSystemdUnit(input) : renderLaunchdPlist(input);
}

export type ServiceStep = {
  description: string;
  command: string;
  args: string[];
  /** Sıfır olmayan çıkış yazdırılır ve yok sayılır. */
  optional?: boolean;
};

export type ServiceCommandPlan = {
  install: ServiceStep[];
  restart: ServiceStep[];
  stop: ServiceStep[];
  /** Birim dosyası silinmeden önce. */
  uninstall: ServiceStep[];
  /** Birim dosyası silindikten sonra. */
  afterRemove: ServiceStep[];
  status: ServiceStep;
};

export function serviceCommandPlan(
  target: ServiceTarget,
  platform: ServicePlatform,
  options: { uid: number; unitFile: string; start: boolean }
): ServiceCommandPlan {
  const definition = SERVICE_TARGETS[target];
  if (platform === 'systemd') {
    const unit = `${definition.name}.service`;
    const systemctl = (description: string, args: string[], optional = false): ServiceStep => ({
      description,
      command: 'systemctl',
      args: ['--user', ...args],
      ...(optional ? { optional } : {}),
    });
    // StartLimitBurst tetiklendikten sonra systemd hata durumu temizlenene dek başlatmaz.
    const resetFailed = systemctl('clearing the failed state', ['reset-failed', unit], true);
    const reload = systemctl('reloading systemd user units', ['daemon-reload']);
    return {
      install: [
        reload,
        systemctl('enabling the service at login/boot', ['enable', unit]),
        resetFailed,
        ...(options.start ? [systemctl('starting the service', ['restart', unit])] : []),
      ],
      restart: [resetFailed, systemctl('restarting the service', ['restart', unit])],
      stop: [systemctl('stopping the service', ['stop', unit])],
      uninstall: [
        systemctl('stopping and disabling the service', ['disable', '--now', unit], true),
      ],
      afterRemove: [reload, resetFailed],
      status: systemctl('reading the service state', [
        'show',
        unit,
        '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID',
      ]),
    };
  }

  const domain = `gui/${options.uid}`;
  const service = `${domain}/${definition.launchdLabel}`;
  const launchctl = (description: string, args: string[], optional = false): ServiceStep => ({
    description,
    command: 'launchctl',
    args,
    ...(optional ? { optional } : {}),
  });
  // `bootout --wait` belgelenmemiştir ama ExitTimeOut boyunca bekler; bootstrap EIO yarışını önler.
  const bootout = launchctl(
    'unloading the previous launch agent',
    ['bootout', '--wait', service],
    true
  );
  return {
    install: [
      bootout,
      // Kalıcı bir `launchctl disable` kaydı bootstrap'i reddeder; temizlenir.
      launchctl('enabling the launch agent', ['enable', service], true),
      ...(options.start
        ? [
            launchctl('loading and starting the launch agent', [
              'bootstrap',
              domain,
              options.unitFile,
            ]),
          ]
        : []),
    ],
    restart: [launchctl('restarting the service', ['kickstart', '-k', service])],
    stop: [launchctl('stopping the service until the next login', ['bootout', '--wait', service])],
    uninstall: [bootout],
    afterRemove: [],
    status: launchctl('reading the service state', ['print', service]),
  };
}

/** `KEY=VALUE` satırları; kullanıcı düzenler, kurulum yeniden yazmaz. Sır yazılmaz. */
export function renderEnvFileTemplate(target: ServiceTarget): string {
  const lines = [
    `# ${SERVICE_TARGETS[target].description} — service environment`,
    '#',
    '# KEY=VALUE per line. Values are literal (no shell expansion); quote values containing',
    '# spaces or #. This file survives "service install" and upgrades. Run',
    '# "orkestra-workspace-server service restart" after editing.',
    '# If you put credentials here, restrict the file: chmod 600 <this file>.',
    '#',
  ];
  if (target === 'desktop-host') {
    lines.push(
      '# Display name shown to paired devices:',
      '# SOVRA_HOST_NAME=build-box',
      '# On Linux machines without a keyring, allow the basic (unencrypted) secret store:',
      '# SOVRA_ALLOW_BASIC_STORAGE=1'
    );
  } else {
    lines.push('# Example:', '# ORKESTRA_WS_RIPGREP_PATH=/usr/bin/rg');
  }
  return `${lines.join('\n')}\n`;
}
