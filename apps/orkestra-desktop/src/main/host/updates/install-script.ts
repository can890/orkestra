import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { quoteArg } from '@orkestra/core/primitives/exec/api';

export type InstallScriptParams = {
  /** Kapanması beklenen Orkestra ana sürecinin kimliği. */
  parentPid: number;
  /** Yerinde değiştirilecek çalışan paket, ör. /Applications/Orkestra.app */
  targetApp: string;
  /** Doğrulanmış yeni paket (geçici açma dizininde). */
  sourceApp: string;
  /** Çalışan uygulamanın tasarlanmış imza gereksinimi; kopya kurulmadan önce yeniden doğrulanır. */
  requirement: string;
  /** Yardımcının adımlarını yazdığı kayıt dosyası. */
  logFile: string;
  /** Başarısızlıkta nedenin yazıldığı dosya; uygulama bir sonraki açılışta okuyup gösterir. */
  resultFile: string;
  /** Başarılı kurulumdan sonra silinecek geçici açma dizini. */
  cleanupDir: string;
  /** Hazırlık ve yedek paket adlarını benzersiz kılan damga. */
  stamp: string;
  /** Uygulamanın kapanması için beklenecek en uzun süre (saniye). */
  waitTimeoutSeconds?: number;
};

export type InstallScriptPaths = {
  /** Yeni paketin hedefle aynı birimde, atomik yeniden adlandırma için hazırlandığı yol. */
  staged: string;
  /** Eski paketin geri alma için kenara alındığı yol. */
  backup: string;
};

const POLL_INTERVAL_SECONDS = 0.2;

/** Hazırlık ve yedek yolları hedefle aynı klasördedir; böylece `mv` atomik bir yeniden adlandırmadır. */
export function installScriptPaths(targetApp: string, stamp: string): InstallScriptPaths {
  const dir = dirname(targetApp);
  const name = basename(targetApp);
  return {
    staged: join(dir, `.${name}.update-${stamp}`),
    backup: join(dir, `.${name}.previous-${stamp}`),
  };
}

function assertSafePath(label: string, value: string, minDepth: number): void {
  if (!value || !isAbsolute(value) || normalize(value) !== value || /[\0\n\r]/.test(value)) {
    throw new Error(`Kurulum yardımcısı için geçersiz yol (${label}): ${value}`);
  }
  if (value.split('/').filter(Boolean).length < minDepth) {
    throw new Error(`Kurulum yardımcısı için fazla geniş yol (${label}): ${value}`);
  }
}

/**
 * Uygulama kapandıktan sonra çalışan bağımsız kabuk betiğini üretir. Betik:
 * 1. Orkestra ana sürecinin çıkmasını bekler (zaman aşımında hiçbir şeye dokunmadan çıkar).
 * 2. Yeni paketi hedefle aynı klasöre kopyalar, karantina özniteliğini kaldırır ve imzasını
 *    çalışan uygulamanın gereksinimine karşı yeniden doğrular.
 * 3. Eski paketi kenara alır, yenisini yerine koyar; ikinci adım başarısız olursa eskisini geri
 *    yükler (rollback) ve nedeni sonuç dosyasına yazar.
 * 4. Uygulamayı yeniden açar; başarılıysa yedeği ve geçici dosyaları siler.
 * Tüm değerler POSIX tek tırnaklarıyla gömülür; betik yorumlanırken genişletme yapılmaz.
 */
export function buildInstallScript(params: InstallScriptParams): string {
  if (!Number.isInteger(params.parentPid) || params.parentPid <= 1) {
    throw new Error(`Kurulum yardımcısı için geçersiz süreç kimliği: ${params.parentPid}`);
  }
  assertSafePath('hedef', params.targetApp, 2);
  if (!params.targetApp.endsWith('.app')) {
    throw new Error(`Hedef bir uygulama paketi değil: ${params.targetApp}`);
  }
  assertSafePath('kaynak', params.sourceApp, 3);
  assertSafePath('kayıt', params.logFile, 3);
  assertSafePath('sonuç', params.resultFile, 3);
  assertSafePath('geçici dizin', params.cleanupDir, 3);
  if (!/^[A-Za-z0-9_-]+$/.test(params.stamp)) {
    throw new Error(`Kurulum yardımcısı için geçersiz damga: ${params.stamp}`);
  }
  if (!params.requirement.trim() || /[\0\n\r]/.test(params.requirement)) {
    throw new Error('Kurulum yardımcısı için imza gereksinimi eksik.');
  }
  const { staged, backup } = installScriptPaths(params.targetApp, params.stamp);
  const waitLimit = Math.ceil((params.waitTimeoutSeconds ?? 120) / POLL_INTERVAL_SECONDS);
  const q = (value: string) => quoteArg(value, 'posix');

  return `#!/bin/sh
# Orkestra güncelleme yardımcısı — Orkestra tarafından otomatik üretildi, elle düzenlemeyin.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

PARENT_PID=${params.parentPid}
TARGET=${q(params.targetApp)}
SOURCE=${q(params.sourceApp)}
STAGED=${q(staged)}
BACKUP=${q(backup)}
REQUIREMENT=${q(params.requirement)}
LOG_FILE=${q(params.logFile)}
RESULT_FILE=${q(params.resultFile)}
CLEANUP_DIR=${q(params.cleanupDir)}
WAIT_LIMIT=${waitLimit}

log() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

relaunch() {
  if [ -d "$TARGET" ]; then
    open "$TARGET" >/dev/null 2>&1 || log "Uygulama yeniden açılamadı: $TARGET"
  elif [ -d "$BACKUP" ]; then
    open "$BACKUP" >/dev/null 2>&1 || log "Yedek uygulama açılamadı: $BACKUP"
  fi
}

fail() {
  log "HATA: $1"
  printf '%s\\n' "$1" > "$RESULT_FILE" 2>/dev/null || true
  rm -rf "$STAGED"
  relaunch
  exit 1
}

log "Güncelleme yardımcısı başladı; Orkestra'nın (pid $PARENT_PID) kapanması bekleniyor."
waited=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if [ "$waited" -ge "$WAIT_LIMIT" ]; then
    log "Orkestra zamanında kapanmadı; hiçbir dosyaya dokunulmadı."
    printf '%s\\n' "Orkestra zamanında kapanmadığı için güncelleme kurulmadı." > "$RESULT_FILE" 2>/dev/null || true
    exit 1
  fi
  sleep ${POLL_INTERVAL_SECONDS}
  waited=$((waited + 1))
done

rm -rf "$STAGED"
ditto "$SOURCE" "$STAGED" || fail "Yeni sürüm uygulama klasörüne kopyalanamadı."
xattr -dr com.apple.quarantine "$STAGED" 2>/dev/null || true
codesign --verify --deep --strict -R "=$REQUIREMENT" "$STAGED" >/dev/null 2>&1 \\
  || fail "Kopyalanan yeni sürümün imzası doğrulanamadı; eski sürüm korunuyor."

rm -rf "$BACKUP"
mv "$TARGET" "$BACKUP" || fail "Eski sürüm kenara alınamadı; eski sürüm korunuyor."
if ! mv "$STAGED" "$TARGET"; then
  if mv "$BACKUP" "$TARGET"; then
    fail "Yeni sürüm yerine konamadı; eski sürüm geri yüklendi."
  fi
  fail "Yeni sürüm yerine konamadı ve eski sürüm geri yüklenemedi. Eski uygulama: $BACKUP"
fi

rm -rf "$BACKUP"
rm -f "$RESULT_FILE"
log "Güncelleme kuruldu; Orkestra yeniden açılıyor."
relaunch
rm -rf "$CLEANUP_DIR"
exit 0
`;
}
