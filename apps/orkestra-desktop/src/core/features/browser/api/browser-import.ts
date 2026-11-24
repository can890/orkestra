// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/contracts/src/browserImport.ts
//
// Kurulu tarayıcılardan uygulama içi tarayıcı profiline çerez aktarımının renderer ↔ main
// sözleşme tipleri. Çerez değerleri bu sözleşmeden asla geçmez; yalnızca sayılar ve alan adları.
import { z } from 'zod';

export const BROWSER_IMPORT_SOURCE_IDS = [
  'chrome',
  'edge',
  'brave',
  'vivaldi',
  'opera',
  'arc',
  'helium',
  'chromium',
  'firefox',
  'zen',
  'safari',
] as const;

export const browserImportSourceIdSchema = z.enum(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = z.infer<typeof browserImportSourceIdSchema>;

export type BrowserImportEngine = 'chromium' | 'firefox' | 'safari';

export const BROWSER_IMPORT_UNAVAILABLE_REASONS = [
  'notInstalled',
  'needsKeychainApproval',
  'keychainItemMissing',
  'needsFullDiskAccess',
  'browserRunning',
  'unsupportedPlatform',
] as const;
export type BrowserImportUnavailableReason = (typeof BROWSER_IMPORT_UNAVAILABLE_REASONS)[number];

export const BROWSER_IMPORT_FAILURE_REASONS = [
  ...BROWSER_IMPORT_UNAVAILABLE_REASONS,
  'keychainUnavailable',
  'unknownSource',
  'unknownSourceProfile',
  'unknownTargetProfile',
  'sessionUnavailable',
  'readFailed',
] as const;
export type BrowserImportFailureReason = (typeof BROWSER_IMPORT_FAILURE_REASONS)[number];

export type BrowserImportSourceProfile = {
  /** Kaynak tarayıcının profil dizini (kullanıcı veri dizinine göreli ya da mutlak). */
  directory: string;
  name: string;
  /** Profildeki çerez sayısı; okunamazsa yok. */
  cookieCount?: number;
};

export type BrowserImportSource = {
  id: BrowserImportSourceId;
  name: string;
  engine: BrowserImportEngine;
  profiles: BrowserImportSourceProfile[];
  unavailable?: BrowserImportUnavailableReason;
};

export const browserImportInputSchema = z.object({
  sourceId: browserImportSourceIdSchema,
  sourceProfileDirectory: z.string().min(1),
  /** Hedef Orkestra tarayıcı profili (ayarlardaki adlandırılmış profil kimliği). */
  targetProfileId: z.string().min(1),
});
export type BrowserImportInput = z.infer<typeof browserImportInputSchema>;

export type BrowserImportSummary = {
  imported: number;
  /** Toplam atlanan çerez sayısı (aşağıdaki nedenlerin toplamı). */
  skipped: number;
  skippedExpired: number;
  skippedPartitioned: number;
  skippedUndecryptable: number;
  skippedRejected: number;
  /** Atlanan çerezlerin ilk 20 alan adı; çerez adı ya da değeri içermez. */
  skippedDomains: string[];
};

export type BrowserImportResult =
  | { success: true; summary: BrowserImportSummary }
  | { success: false; reason: BrowserImportFailureReason };

export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  notInstalled: 'Not installed on this machine.',
  needsKeychainApproval:
    'Keychain access was not allowed. Retry and choose Allow when macOS asks for the Safe Storage key.',
  keychainItemMissing:
    'No cookie encryption key was found in your keychain. Open that browser once, then retry.',
  needsFullDiskAccess:
    'Give Orkestra Full Disk Access in System Settings → Privacy & Security, then retry.',
  browserRunning: 'Quit the browser first so its cookie database can be read.',
  unsupportedPlatform: 'Importing from this browser is not supported on this platform.',
  keychainUnavailable:
    'The system keyring could not be accessed. Make sure it is running and unlocked, then retry.',
  unknownSource: 'That browser is no longer available to import from.',
  unknownSourceProfile: 'That browser profile no longer exists.',
  unknownTargetProfile: 'The Orkestra browser profile no longer exists.',
  sessionUnavailable: 'The Orkestra browser profile could not be opened.',
  readFailed: 'The browser cookie database could not be read.',
};

export function isRetryableBrowserImportReason(reason: BrowserImportFailureReason): boolean {
  return (
    reason === 'needsKeychainApproval' ||
    reason === 'keychainUnavailable' ||
    reason === 'browserRunning' ||
    reason === 'readFailed'
  );
}
