// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/provider-acp-registry/src/server/AcpRegistrySupport.ts
// Platform/mimari çözümü ve dağıtım seçimi (binary > npx > uvx). Saf fonksiyonlar; ağ veya
// dosya sistemi kullanmaz.
import type { AcpRegistryAgent, AcpRegistryBinaryTarget } from './registry-schema';

export type AcpRegistryPlatformTarget =
  | 'darwin-aarch64'
  | 'darwin-x86_64'
  | 'linux-aarch64'
  | 'linux-x86_64'
  | 'windows-aarch64'
  | 'windows-x86_64';

export type AcpRegistryDistributionKind = 'binary' | 'npx' | 'uvx';
export type AcpRegistryDistributionPreference = 'auto' | AcpRegistryDistributionKind;

export function resolveAcpRegistryPlatformTarget(
  platform: string,
  architecture: string
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : undefined;
  const arch = architecture === 'arm64' ? 'aarch64' : architecture === 'x64' ? 'x86_64' : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

export function acpRegistryPlatformTargetCandidates(
  target: AcpRegistryPlatformTarget | undefined
): AcpRegistryPlatformTarget[] {
  if (target === undefined) return [];
  // Windows 11 ARM, yerel derleme yoksa x86_64 ikililerini öykünebilir.
  if (target === 'windows-aarch64') return ['windows-aarch64', 'windows-x86_64'];
  return [target];
}

export type ResolvedAcpRegistryDistribution = {
  kind: AcpRegistryDistributionKind;
  args: string[];
  env: Record<string, string>;
  binaryTarget?: AcpRegistryBinaryTarget;
  /** Eşleşen ikili hedefi (ör. windows-aarch64 üzerinde windows-x86_64). */
  platformTarget?: AcpRegistryPlatformTarget;
  packageSpec?: string;
};

export function resolveAcpRegistryDistribution(input: {
  agent: AcpRegistryAgent;
  preference?: AcpRegistryDistributionPreference;
  platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const preference = input.preference ?? 'auto';
  let binary: { target: AcpRegistryPlatformTarget; entry: AcpRegistryBinaryTarget } | undefined;
  for (const candidate of acpRegistryPlatformTargetCandidates(platformTarget)) {
    const entry = agent.distribution.binary?.[candidate];
    if (entry) {
      binary = { target: candidate, entry };
      break;
    }
  }
  const kinds: AcpRegistryDistributionKind[] =
    preference === 'auto' ? ['binary', 'npx', 'uvx'] : [preference];
  for (const kind of kinds) {
    if (kind === 'binary' && binary) {
      return {
        kind,
        args: binary.entry.args ?? [],
        env: binary.entry.env ?? {},
        binaryTarget: binary.entry,
        platformTarget: binary.target,
      };
    }
    // npx/uvx paketleri platformdan bağımsızdır, ancak desteklenmeyen platformlarda da
    // Node/uv çalışabilir; T3 ile aynı şekilde paket dağıtımı platform hedefi aramaz.
    if (kind === 'npx' && agent.distribution.npx) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageSpec: agent.distribution.npx.package,
      };
    }
    if (kind === 'uvx' && agent.distribution.uvx) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageSpec: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

export function packageManagerFor(kind: AcpRegistryDistributionKind): 'npm' | 'uv' | undefined {
  return kind === 'npx' ? 'npm' : kind === 'uvx' ? 'uv' : undefined;
}

export type ExactPackageSpec = { name: string; version: string };

export function parseNpxPackageSpec(spec: string): ExactPackageSpec {
  const separator = spec.lastIndexOf('@');
  return { name: spec.slice(0, separator), version: spec.slice(separator + 1).replace(/^v/iu, '') };
}

export function parseUvxPackageSpec(spec: string): ExactPackageSpec {
  const equals = spec.lastIndexOf('==');
  const separator = equals >= 0 ? equals : spec.lastIndexOf('@');
  const length = equals >= 0 ? 2 : 1;
  return {
    name: spec.slice(0, separator),
    version: spec.slice(separator + length).replace(/^v/iu, ''),
  };
}

/** Kayıttaki `cmd` göreli yolunu güvenli segmentlere böler; kök dışına çıkan yollar reddedilir. */
export function normalizeRegistryCommandPath(command: string): string[] | undefined {
  const normalized = command.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/u.test(normalized) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return segments;
}

/** Arşiv listesindeki her girdinin güvenli göreli yol olduğunu doğrular. */
export function validateArchiveEntries(listing: string): boolean {
  return listing
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => entry === './' || normalizeRegistryCommandPath(entry) !== undefined);
}

export type ArchiveKind = 'raw' | 'tar_bz2' | 'tar_gz' | 'zip';

export function archiveKind(url: string): ArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz')) return 'tar_gz';
  if (pathname.endsWith('.tar.bz2') || pathname.endsWith('.tbz2')) return 'tar_bz2';
  if (pathname.endsWith('.zip')) return 'zip';
  return 'raw';
}

/** Kurulum dizin adı olarak güvenli sürüm segmenti. */
export function versionDirectoryName(version: string): string {
  return encodeURIComponent(version);
}
