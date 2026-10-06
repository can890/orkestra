import { join } from 'node:path';

export type ExecResult = { stdout: string; stderr: string };
/** Kabuk kullanmadan bir aracı argüman dizisiyle çalıştırır; sıfırdan farklı çıkışta hata fırlatır. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<ExecResult>;

export const CODESIGN = '/usr/bin/codesign';
export const PLUTIL = '/usr/bin/plutil';

/** Electron paketinin derin imza doğrulaması büyük paketlerde onlarca saniye sürebilir. */
const VERIFY_TIMEOUT_MS = 180_000;

/**
 * Güvenlik nedeniyle reddedilen (imzası doğrulanamayan ya da farklı kimlik taşıyan) paket.
 * Hizmet bu hatada uygulama içi kurulumu kapatıp sürüm sayfasına yönlendirir.
 */
export class UpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateRefusedError';
  }
}

/** `codesign -d -r-` çıktısından `designated => …` satırını ayıklar. */
export function parseDesignatedRequirement(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^designated => (.+)$/.exec(line.trim());
    if (match) return match[1]!.trim();
  }
  return null;
}

/** Ad-hoc imzalı paketlerin gereksinimi `cdhash H"…"` biçimindedir ve her derlemede değişir. */
export function isAdHocRequirement(requirement: string): boolean {
  return /^cdhash\s/.test(requirement);
}

/** Paketin gömülü imzasındaki tasarlanmış gereksinimi (designated requirement) okur. */
export async function readDesignatedRequirement(exec: ExecFile, appPath: string): Promise<string> {
  let output: ExecResult;
  try {
    output = await exec(CODESIGN, ['-d', '-r-', appPath]);
  } catch (error) {
    throw new UpdateRefusedError(
      `Uygulamanın imza gereksinimi okunamadı (${appPath}): ${errorMessage(error)}`
    );
  }
  const requirement = parseDesignatedRequirement(`${output.stdout}\n${output.stderr}`);
  if (!requirement) {
    throw new UpdateRefusedError(`Uygulamanın imza gereksinimi bulunamadı (${appPath}).`);
  }
  return requirement;
}

async function readPlistValue(exec: ExecFile, appPath: string, key: string): Promise<string> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await exec(PLUTIL, ['-extract', key, 'raw', '-o', '-', plist]);
  return stdout.trim();
}

/** Çalışan uygulamanın paket kimliğini (CFBundleIdentifier) okur. */
export function readBundleIdentifier(exec: ExecFile, appPath: string): Promise<string> {
  return readPlistValue(exec, appPath, 'CFBundleIdentifier');
}

export type SignatureCheckInput = {
  /** Doğrulanacak, yeni indirilip açılmış paket. */
  candidateApp: string;
  /** Çalışan uygulamanın tasarlanmış gereksinimi. */
  runningRequirement: string;
  /** Çalışan uygulamanın paket kimliği (CFBundleIdentifier). */
  runningBundleId: string;
  /** Sürüm etiketinden beklenen CFBundleShortVersionString. */
  expectedVersion: string;
};

/**
 * Yeni paketin bütünlüğünü ve kimliğini doğrular; herhangi bir adım başarısızsa
 * {@link UpdateRefusedError} fırlatır:
 * 1. `codesign --verify --deep --strict` — imza bozulmamış, içerik değiştirilmemiş.
 * 2. Yeni paketin tasarlanmış gereksinimi çalışan uygulamanınkiyle birebir aynı.
 * 3. `-R` ile yeni paket çalışan uygulamanın gereksinimini kriptografik olarak karşılıyor
 *    (başka bir sertifikayla imzalanıp aynı gereksinim metnini taşıyan paketler burada düşer).
 * 4. Paket kimliği ve sürümü beklenenle aynı.
 */
export async function verifyCandidateSignature(
  exec: ExecFile,
  input: SignatureCheckInput
): Promise<void> {
  const { candidateApp, runningRequirement } = input;
  if (isAdHocRequirement(runningRequirement)) {
    throw new UpdateRefusedError(
      'Çalışan Orkestra ad-hoc imzalı; yeni sürümün kimliği doğrulanamaz.'
    );
  }
  try {
    await exec(CODESIGN, ['--verify', '--deep', '--strict', candidateApp], {
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (error) {
    throw new UpdateRefusedError(
      `İndirilen sürümün kod imzası geçersiz; güncelleme reddedildi. (${errorMessage(error)})`
    );
  }
  const candidateRequirement = await readDesignatedRequirement(exec, candidateApp);
  if (candidateRequirement !== runningRequirement) {
    throw new UpdateRefusedError(
      'İndirilen sürüm çalışan Orkestra ile aynı imza kimliğini taşımıyor; güncelleme reddedildi.'
    );
  }
  try {
    await exec(
      CODESIGN,
      ['--verify', '--deep', '--strict', '-R', `=${runningRequirement}`, candidateApp],
      { timeoutMs: VERIFY_TIMEOUT_MS }
    );
  } catch {
    throw new UpdateRefusedError(
      'İndirilen sürüm çalışan Orkestra’nın imza gereksinimini karşılamıyor; güncelleme reddedildi.'
    );
  }
  let bundleId: string;
  let version: string;
  try {
    bundleId = await readPlistValue(exec, candidateApp, 'CFBundleIdentifier');
    version = await readPlistValue(exec, candidateApp, 'CFBundleShortVersionString');
  } catch (error) {
    throw new UpdateRefusedError(
      `İndirilen sürümün paket bilgileri okunamadı: ${errorMessage(error)}`
    );
  }
  if (bundleId !== input.runningBundleId) {
    throw new UpdateRefusedError(
      `İndirilen paketin kimliği (${bundleId}) çalışan uygulamayla (${input.runningBundleId}) eşleşmiyor.`
    );
  }
  if (version !== input.expectedVersion) {
    throw new UpdateRefusedError(
      `İndirilen paket ${version} sürümünü taşıyor; beklenen ${input.expectedVersion}.`
    );
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().slice(0, 240);
  }
  return error instanceof Error ? error.message : String(error);
}
