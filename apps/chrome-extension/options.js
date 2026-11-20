import { DEFAULT_PORT, buildConnection } from './lib/policy.js';

const $ = (id) => document.getElementById(id);
const say = (text) => {
  $('message').textContent = text;
};

async function load() {
  const stored = await chrome.storage.local.get(['port']);
  $('port').value = String(stored.port ?? DEFAULT_PORT);
}

$('save').onclick = async () => {
  const settings = { port: Number($('port').value) };
  if (!buildConnection(settings)) {
    say('Bağlantı noktası geçersiz (1024-65535 aralığında olmalıdır).');
    return;
  }
  await chrome.storage.local.set({ ...settings, enabled: true });
  await chrome.runtime.sendMessage({ type: 'reload' });
  say('Kaydedildi. Bağlantı durumu için uzantı simgesine bakın.');
};

void load();
