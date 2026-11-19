import { DEFAULT_PORT, buildConnection, originPattern } from './lib/policy.js';

const $ = (id) => document.getElementById(id);
const say = (text) => {
  $('message').textContent = text;
};

async function load() {
  const stored = await chrome.storage.local.get(['token', 'port']);
  $('token').value = stored.token ?? '';
  $('port').value = String(stored.port ?? DEFAULT_PORT);
}

$('save').onclick = async () => {
  const settings = { token: $('token').value.trim(), port: Number($('port').value) };
  if (!buildConnection(settings)) {
    say('Belirteç (64 onaltılık karakter) ya da bağlantı noktası geçersiz.');
    return;
  }
  await chrome.storage.local.set({ ...settings, enabled: true });
  await chrome.runtime.sendMessage({ type: 'reload' });
  say('Kaydedildi. Bağlantı durumu için uzantı simgesine bakın.');
};

$('allow').onclick = async () => {
  const pattern = originPattern($('site').value.trim());
  if (!pattern) {
    say('Geçerli bir http/https adresi girin.');
    return;
  }
  // Kullanıcının bu tıklaması izin iletişim kutusunu açmak için gereken hareketi sağlar.
  const granted = await chrome.permissions.request({ origins: [pattern] });
  say(granted ? `${pattern.slice(0, -2)} için izin verildi.` : 'İzin verilmedi.');
};

void load();
