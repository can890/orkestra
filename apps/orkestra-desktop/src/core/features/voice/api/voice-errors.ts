import type { MicrophoneAccess, VoiceError } from './contract';

/** Ses hatalarının kullanıcıya gösterilecek Türkçe karşılığı. */
export function voiceErrorMessage(error: VoiceError): string {
  switch (error.type) {
    case 'missing_api_key':
      return 'ElevenLabs API anahtarı ayarlanmamış. Ayarlar > Ses bölümünden ekleyin.';
    case 'invalid_api_key':
      return 'ElevenLabs API anahtarı geçersiz ya da bu işlem için yetkisi yok.';
    case 'quota_exceeded':
      return 'ElevenLabs kullanım kotanız doldu.';
    case 'rate_limited':
      return 'ElevenLabs çok fazla istek aldı; biraz sonra tekrar deneyin.';
    case 'invalid_input':
      return `İstek geçersiz: ${error.message}`;
    case 'network':
      return 'ElevenLabs sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edin.';
    case 'http':
      return `ElevenLabs isteği başarısız oldu (HTTP ${error.status}).`;
    case 'storage_unavailable':
      return 'Güvenli anahtar deposu bu sistemde kullanılamıyor; API anahtarı kaydedilemedi.';
  }
}

/** Hata, kullanıcıyı Ayarlar > Ses sayfasına yönlendirmeyi gerektiriyor mu? */
export function voiceErrorNeedsSettings(error: VoiceError): boolean {
  return error.type === 'missing_api_key' || error.type === 'invalid_api_key';
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
