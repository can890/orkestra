import { execFileSync } from 'node:child_process';

export const DEFAULT_LOCAL_MAC_SIGNING_IDENTITY = 'Sovra Local Signing';

function readCodesigningIdentities(): string {
  return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Yerel macOS derlemelerinde sabit self-signed kod imzalama kimliğini algılar.
 * Böylece yeni sürümler ad-hoc yerine aynı sertifikayla imzalanır ve macOS TCC
 * izinleri (Ekran Kaydı, Erişilebilirlik, Mikrofon) güncellemelerde sıfırlanmaz.
 * CI veya açık CSC_* değişkenleri varsa devreye girmez.
 */
export function resolveLocalMacSigningIdentity(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readIdentities: () => string = readCodesigningIdentities
): string | undefined {
  if (platform !== 'darwin') return undefined;
  if (env.CI === 'true' || env.CI === '1') return undefined;
  if (env.CSC_LINK || env.CSC_NAME) return undefined;
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return undefined;

  const target = env.ORKESTRA_LOCAL_MAC_IDENTITY?.trim() || DEFAULT_LOCAL_MAC_SIGNING_IDENTITY;
  try {
    const output = readIdentities();
    return output.includes(`"${target}"`) ? target : undefined;
  } catch {
    return undefined;
  }
}
