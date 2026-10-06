import path from 'node:path';
import { quoteArg } from '@orkestra/core/primitives/exec/api';
import type {
  HostHealth,
  PruneResult,
  ServerVersionEntry,
} from '../../../api/maintenance-contract';
import { validateWorkspaceServerVersion, type WorkspaceServerLayout } from '../layout';
import type { WorkspaceServerSshPort } from '../ports';

/** Kurulum betiğiyle aynı kilit: kurulum sürerken temizlik yapılmaz. */
export const PRUNE_LOCK_BUSY_EXIT_CODE = 43;

const inspectExecOptions = {
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1_024,
  maxStderrBytes: 16 * 1_024,
} as const;

export type RawVersionListing = {
  /** `readlink current` çıktısı; okunamazsa boş. */
  currentTarget: string;
  /** Değişiklik zamanına göre yeniden eskiye sıralı dizin adları ve KiB boyutları. */
  versions: Array<{ name: string; kib?: number }>;
  rootKib?: number;
  freeKib?: number;
};

/**
 * Sağlık bilgisini tek bir salt-okunur betikle toplar. Tüm yollar düzenden gelir ve
 * `quoteArg` ile alıntılanır; dizin adları yalnızca veri olarak yazdırılır.
 */
export function buildHealthInspectionScript(layout: WorkspaceServerLayout): string {
  const root = quoteArg(layout.root, 'posix');
  const versions = quoteArg(layout.versionsDirectory, 'posix');
  const current = quoteArg(layout.currentLink, 'posix');
  return `set -u
root=${root}
versions=${versions}
current=${current}
printf 'current\\t%s\\n' "$(readlink -- "$current" 2>/dev/null || true)"
if [ -d "$versions" ]; then
  ls -1t -- "$versions" | while IFS= read -r name; do
    [ -d "$versions/$name" ] || continue
    size=$(du -sk -- "$versions/$name" 2>/dev/null | cut -f1)
    printf 'version\\t%s\\t%s\\n' "$name" "\${size:-}"
  done
fi
if [ -d "$root" ]; then
  printf 'root\\t%s\\n' "$(du -sk -- "$root" 2>/dev/null | cut -f1)"
  printf 'free\\t%s\\n' "$(df -Pk -- "$root" 2>/dev/null | awk 'NR==2 {print $4}')"
fi`;
}

export function parseHealthInspection(stdout: string): RawVersionListing {
  const listing: RawVersionListing = { currentTarget: '', versions: [] };
  for (const line of stdout.split('\n')) {
    const [tag, ...fields] = line.split('\t');
    switch (tag) {
      case 'current':
        listing.currentTarget = (fields[0] ?? '').trim();
        break;
      case 'version': {
        const name = fields[0] ?? '';
        if (name) listing.versions.push({ name, kib: parseKib(fields[1]) });
        break;
      }
      case 'root':
        listing.rootKib = parseKib(fields[0]);
        break;
      case 'free':
        listing.freeKib = parseKib(fields[0]);
        break;
    }
  }
  return listing;
}

/** `versions/<v>` ya da mutlak sürüm yolu dışındaki hedefler tanınmaz. */
export function currentVersionFromTarget(
  layout: WorkspaceServerLayout,
  target: string
): string | undefined {
  if (!target) return undefined;
  const name = path.posix.basename(target);
  if (!isValidVersionName(name)) return undefined;
  if (target !== `versions/${name}` && target !== layout.versionDirectory(name)) return undefined;
  return name;
}

export type ClassifyVersionsInput = {
  /** Yeniden eskiye sıralı. */
  versions: ReadonlyArray<{ name: string; bytes?: number }>;
  currentVersion: string | undefined;
  runningVersion: string | undefined;
};

/**
 * Hangi sürümlerin silinebileceğine karar verir. Asla silinmez: current, çalışan sürüm,
 * en yeni önceki sürüm (geri dönüş hedefi) ve adı geçerli sürüm olmayan dizinler.
 * current belirlenemezse hiçbir şey silinmez.
 */
export function classifyVersions(input: ClassifyVersionsInput): {
  entries: ServerVersionEntry[];
  pruneBlockedReason?: string;
} {
  const { currentVersion, runningVersion } = input;
  const blocked = currentVersion === undefined;
  // Çalışan sürüm current'tan farklıysa (kuruldu ama yeniden başlatılmadı) zaten bir geri
  // dönüş noktasıdır; aksi halde en yeni diğer sürüm "önceki" olarak korunur.
  let previousAssigned = runningVersion !== undefined && runningVersion !== currentVersion;
  const entries = input.versions.map((version): ServerVersionEntry => {
    const base = version.bytes === undefined ? {} : { bytes: version.bytes };
    if (!isValidVersionName(version.name)) {
      return { name: version.name, ...base, role: 'unrecognized' };
    }
    if (version.name === currentVersion) return { name: version.name, ...base, role: 'current' };
    if (version.name === runningVersion) return { name: version.name, ...base, role: 'running' };
    if (!previousAssigned) {
      previousAssigned = true;
      return { name: version.name, ...base, role: 'previous' };
    }
    return { name: version.name, ...base, role: blocked ? 'kept' : 'prunable' };
  });
  return blocked
    ? { entries, pruneBlockedReason: 'Etkin sürüm bağlantısı okunamadı' }
    : { entries };
}

export function summarizeHealth(
  layout: WorkspaceServerLayout,
  listing: RawVersionListing,
  runningVersion: string | undefined,
  checkedAt: number
): HostHealth {
  const currentVersion = currentVersionFromTarget(layout, listing.currentTarget);
  const { entries, pruneBlockedReason } = classifyVersions({
    versions: listing.versions.map((version) => ({
      name: version.name,
      ...(version.kib === undefined ? {} : { bytes: version.kib * 1_024 }),
    })),
    currentVersion,
    runningVersion,
  });
  return {
    checkedAt,
    ...(listing.rootKib === undefined ? {} : { rootBytes: listing.rootKib * 1_024 }),
    ...(listing.freeKib === undefined ? {} : { freeBytes: listing.freeKib * 1_024 }),
    versions: entries,
    prunableBytes: entries
      .filter((entry) => entry.role === 'prunable')
      .reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    ...(pruneBlockedReason ? { pruneBlockedReason } : {}),
  };
}

/**
 * Yalnızca verilen sürümleri siler. Uzak tarafta da kurulum kilidi alınır ve current ile
 * çalışan sürüm son anda yeniden denetlenir; böylece listeleme ile silme arasında yapılan
 * bir kurulum etkin sürümü asla silemez.
 */
export function buildPruneScript(
  layout: WorkspaceServerLayout,
  versions: readonly string[],
  runningVersion: string | undefined
): string {
  if (versions.length === 0) throw new Error('No workspace-server versions to prune');
  const quotedVersions = versions
    .map((version) => quoteArg(validateWorkspaceServerVersion(version), 'posix'))
    .join(' ');
  const running = quoteArg(
    runningVersion === undefined ? '' : validateWorkspaceServerVersion(runningVersion),
    'posix'
  );
  return `set -eu
versions=${quoteArg(layout.versionsDirectory, 'posix')}
current=${quoteArg(layout.currentLink, 'posix')}
lock=${quoteArg(layout.installLock, 'posix')}
running=${running}
if ! mkdir -- "$lock" 2>/dev/null; then
  echo "workspace-server install in progress" >&2
  exit ${PRUNE_LOCK_BUSY_EXIT_CODE}
fi
trap 'rm -rf -- "$lock"' EXIT HUP INT TERM
printf '%s\\n' "$$" > "$lock/pid"
current_target=$(readlink -- "$current" 2>/dev/null || true)
current_name=\${current_target##*/}
if [ -z "$current_name" ]; then
  echo "workspace-server current link is unreadable" >&2
  exit 44
fi
for name in ${quotedVersions}; do
  if [ "$name" = "$current_name" ] || [ "$name" = "$running" ]; then
    printf 'skipped\\t%s\\n' "$name"
    continue
  fi
  [ -d "$versions/$name" ] || continue
  rm -rf -- "$versions/$name"
  printf 'removed\\t%s\\n' "$name"
done`;
}

export function parsePruneOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([tag, name]) => tag === 'removed' && !!name)
    .map(([, name]) => name!);
}

export class HostHealthError extends Error {
  readonly name = 'HostHealthError';
}

/** SSH vekil yürütme yardımcıları üzerinden sağlık okuma ve temizlik. */
export class RemoteHostHealthInspector {
  constructor(
    private readonly connectionId: string,
    private readonly ssh: WorkspaceServerSshPort
  ) {}

  async inspect(layout: WorkspaceServerLayout, signal?: AbortSignal): Promise<RawVersionListing> {
    const proxy = await this.ssh.ensureProxy(this.connectionId);
    const result = await proxy.execScript(buildHealthInspectionScript(layout), {
      ...inspectExecOptions,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new HostHealthError(
        `Sunucu sağlığı okunamadı: ${result.stderr.trim() || `çıkış ${result.exitCode}`}`
      );
    }
    return parseHealthInspection(result.stdout);
  }

  async prune(
    layout: WorkspaceServerLayout,
    health: HostHealth,
    runningVersion: string | undefined,
    signal?: AbortSignal
  ): Promise<PruneResult> {
    if (health.pruneBlockedReason) throw new HostHealthError(health.pruneBlockedReason);
    const prunable = health.versions.filter((entry) => entry.role === 'prunable');
    if (prunable.length === 0) return { removed: [], freedBytes: 0 };
    const proxy = await this.ssh.ensureProxy(this.connectionId);
    const result = await proxy.execScript(
      buildPruneScript(
        layout,
        prunable.map((entry) => entry.name),
        runningVersion
      ),
      { ...inspectExecOptions, timeoutMs: 120_000, signal }
    );
    if (result.exitCode === PRUNE_LOCK_BUSY_EXIT_CODE) {
      throw new HostHealthError('Sunucu kurulumu sürüyor; temizlik daha sonra yeniden denenmeli');
    }
    if (result.exitCode !== 0) {
      throw new HostHealthError(
        `Eski sürümler temizlenemedi: ${result.stderr.trim() || `çıkış ${result.exitCode}`}`
      );
    }
    const removed = parsePruneOutput(result.stdout);
    const freedBytes = prunable
      .filter((entry) => removed.includes(entry.name))
      .reduce((total, entry) => total + (entry.bytes ?? 0), 0);
    return { removed, freedBytes };
  }
}

function isValidVersionName(name: string): boolean {
  try {
    validateWorkspaceServerVersion(name);
    return true;
  } catch {
    return false;
  }
}

function parseKib(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
