import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { HostKeyPrompt } from '@core/services/ssh/node/connect/host-key-verifier';

// Sunucuda parmak izini karşılaştırmak için önerilen anahtar dosyası, türe göre.
const SERVER_HOST_KEY_FILES: Readonly<Record<string, string>> = {
  'ssh-ed25519': '/etc/ssh/ssh_host_ed25519_key.pub',
  'ecdsa-sha2-nistp256': '/etc/ssh/ssh_host_ecdsa_key.pub',
  'ecdsa-sha2-nistp384': '/etc/ssh/ssh_host_ecdsa_key.pub',
  'ecdsa-sha2-nistp521': '/etc/ssh/ssh_host_ecdsa_key.pub',
  'ssh-rsa': '/etc/ssh/ssh_host_rsa_key.pub',
};

/** Bilinmeyen bir SSH sunucusunun anahtarını kullanıcıya onaylatır. Varsayılan seçim iptaldir. */
export async function showHostKeyPrompt(prompt: HostKeyPrompt): Promise<boolean> {
  const serverKeyFile = SERVER_HOST_KEY_FILES[prompt.keyType] ?? '/etc/ssh/ssh_host_*_key.pub';
  const detail = [
    'Sunucunun anahtar parmak izi:',
    `${prompt.keyType}  ${prompt.fingerprint}`,
    '',
    ...(prompt.otherKeyTypes.length > 0
      ? [
          `Uyarı: Bu sunucu için daha önce farklı türde bir anahtar kaydedilmiş ` +
            `(${prompt.otherKeyTypes.join(', ')}). Sunucu yeniden kurulmadıysa bağlanmayın.`,
          '',
        ]
      : []),
    'Parmak izinin sunucunuza ait olduğundan eminseniz bağlanın. Sunucuda şu komutla karşılaştırabilirsiniz:',
    `ssh-keygen -lf ${serverKeyFile}`,
  ].join('\n');
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'SSH sunucusunu doğrulayın',
    message: `${prompt.host}:${prompt.port} sunucusuna ilk kez bağlanılıyor`,
    detail,
    buttons: ['İptal', 'Bağlan ve anahtarı kaydet'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}
