import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor } from '@capacitor/core';

export type ScanOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'unsupported' | 'installing' | 'cancelled' | 'failed' };

/**
 * QR okur (Google kod tarayıcısı: kendi ekranını Play Services içinde açar, bu yüzden uygulamanın
 * kamera izni istemesi gerekmez). Desteklenmeyen cihazda/tarayıcıda `unsupported` döner; kullanıcı
 * kodu elle yapıştırır.
 */
export async function scanQrCode(): Promise<ScanOutcome> {
  if (!Capacitor.isNativePlatform()) return { ok: false, reason: 'unsupported' };
  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { ok: false, reason: 'unsupported' };
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return { ok: false, reason: 'installing' };
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const text = barcodes[0]?.rawValue;
    return text ? { ok: true, text } : { ok: false, reason: 'cancelled' };
  } catch {
    // Kullanıcı vazgeçince de istisna oluşur; ayrıntı (içerik) taşınmaz.
    return { ok: false, reason: 'cancelled' };
  }
}
