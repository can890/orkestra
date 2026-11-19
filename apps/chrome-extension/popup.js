import { originPattern } from './lib/policy.js';

const $ = (id) => document.getElementById(id);
const LABELS = {
  connected: 'Masaüstüne bağlı',
  connecting: 'Bağlanıyor…',
  disconnected: 'Bağlı değil',
};

async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

async function render() {
  const status = await send('status');
  $('dot').className = `dot ${status.state}`;
  $('status').textContent = status.enabled
    ? (LABELS[status.state] ?? status.state)
    : 'Bağlantı kesildi';
  $('error').textContent = status.enabled && status.state !== 'connected' ? status.lastError : '';
  $('toggle').textContent = status.enabled ? 'Bağlantıyı kes' : 'Bağlan';
  $('toggle').onclick = async () => {
    await send(status.enabled ? 'disconnect' : 'reconnect');
    setTimeout(render, 600);
  };

  const granted = (await chrome.permissions.getAll()).origins ?? [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = originPattern(tab?.url);
  const current = $('current');
  current.textContent = '';
  if (!pattern) {
    current.textContent = 'Bu sayfa desteklenmiyor (yalnızca http/https siteleri).';
  } else if (granted.includes(pattern)) {
    current.textContent = `${pattern.slice(0, -2)} için izin verildi.`;
  } else {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${pattern.slice(0, -2)} sitesine izin ver`;
    // chrome.permissions.request yalnızca kullanıcı hareketiyle (bu tıklama) çalışır.
    button.onclick = async () => {
      await chrome.permissions.request({ origins: [pattern] });
      await render();
    };
    current.append(button);
  }

  const list = $('sites');
  list.textContent = '';
  for (const origin of granted) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin.slice(0, -2);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Kaldır';
    remove.onclick = async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await render();
    };
    item.append(name, remove);
    list.append(item);
  }
  if (granted.length === 0) list.textContent = 'Henüz izin verilmiş site yok.';
}

$('options').onclick = () => chrome.runtime.openOptionsPage();
void render();
