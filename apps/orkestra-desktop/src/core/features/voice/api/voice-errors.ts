import type { MicrophoneAccess, VoiceError } from './contract';

/** Ses hatalarının kullanıcıya gösterilecek Türkçe karşılığı. */
export function voiceErrorMessage(error: VoiceError): string {
  switch (error.type) {
    case 'missing_api_key':
      return 'Sesli dikte için yerel bir Whisper motoru ya da API anahtarı yapılandırılmamış. Ayarlar > Ses bölümünden seçin.';
    case 'local_stt_unavailable':
      return error.message;
    case 'local_stt_failed':
      return `Yerel ses tanıma hatası: ${error.message}`;
    case 'invalid_api_key':
      return 'API anahtarı geçersiz ya da bu işlem için yetkisi yok.';
    case 'quota_exceeded':
      return 'Sağlayıcı kullanım kotanız doldu.';
    case 'rate_limited':
      return 'Sağlayıcı çok fazla istek aldı; biraz sonra tekrar deneyin.';
    case 'invalid_input':
      return `İstek geçersiz: ${error.message}`;
    case 'network':
      return 'STT sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edin.';
    case 'http':
      return `Ses isteği başarısız oldu (HTTP ${error.status}): ${error.message}`;
    case 'storage_unavailable':
      return 'Güvenli anahtar deposu bu sistemde kullanılamıyor; API anahtarı kaydedilemedi.';
  }
}

/** Hata, kullanıcıyı Ayarlar > Ses sayfasına yönlendirmeyi gerektiriyor mu? */
export function voiceErrorNeedsSettings(error: VoiceError): boolean {
  return (
    error.type === 'missing_api_key' ||
    error.type === 'invalid_api_key' ||
    error.type === 'local_stt_unavailable'
  );
}

export function microphoneAccessMessage(access: MicrophoneAccess): string | null {
  switch (access) {
    case 'denied':
      return 'Mikrofon izni reddedilmiş. Sistem Ayarları > Gizlilik ve Güvenlik > Mikrofon bölümünden Orkestra’ya izin verin.';
    case 'restricted':
      return 'Mikrofon erişimi bu sistemde kısıtlanmış.';
    default:
      return null;
  }
}
