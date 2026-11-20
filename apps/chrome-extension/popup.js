const $ = (id) => document.getElementById(id);

async function send(message) {
  return chrome.runtime.sendMessage(typeof message === 'string' ? { type: message } : message);
}

function relativeTime(timestamp) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 10) return 'şimdi';
  if (diffSec < 60) return `${diffSec} sn`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} dk`;
  return `${Math.floor(diffMin / 60)} sa`;
}

function renderActivity(entries) {
  const list = $('activity');
  const empty = $('activity-empty');
  const clearBtn = $('clear-activity');
  list.textContent = '';

  if (!Array.isArray(entries) || entries.length === 0) {
    empty.hidden = false;
    clearBtn.hidden = true;
    return;
  }

  empty.hidden = true;
  clearBtn.hidden = false;

  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = entry.tabId != null ? 'activity-item clickable' : 'activity-item';

    const dot = document.createElement('span');
    dot.className = entry.ok ? 'act-dot' : 'act-dot err';
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'act-label';
    label.textContent = entry.label || entry.action;

    const host = document.createElement('span');
    host.className = 'act-host';
    host.textContent = entry.host || '';

    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = relativeTime(entry.at);

    item.append(dot, label, host, time);
    if (typeof entry.tabId === 'number') {
      item.title = 'Sekmeye odaklan';
      item.onclick = () => void send({ type: 'focus_tab', tabId: entry.tabId });
    }
    list.append(item);
  }
}

let lastStatus = null;

function applyStatus(status) {
  lastStatus = status;
  const enabled = status?.enabled !== false;
  const connected = enabled && status?.state === 'connected';
  const port = status?.port ?? 47653;

  const toggle = $('toggle');
  const toggleLabel = $('toggle-label');
  toggle.className = enabled ? 'toggle-pill is-enabled' : 'toggle-pill';
  toggle.setAttribute('aria-checked', String(enabled));
  toggleLabel.textContent = enabled ? 'Açık' : 'Duraklatıldı';

  if (!enabled) {
    $('dot').className = 'dot paused';
    $('status').textContent = 'Duraklatıldı';
    $('hint').textContent =
      'Bağlantı duraklatıldı. Yeniden bağlanmak için sağ üstteki anahtarı açın.';
  } else if (connected) {
    $('dot').className = 'dot connected';
    $('status').textContent = status?.activeAction
      ? `Çalışıyor · ${status.activeAction.label}`
      : 'Masaüstüne bağlı';
    $('hint').textContent =
      'Tüm açık sekmeler otomatik erişilebilir; ajan gerekirse yeni sekme de açar.';
  } else {
    $('dot').className = 'dot waiting';
    $('status').textContent = 'Masaüstü bekleniyor…';
    $('hint').textContent =
      'Orkestra masaüstü uygulaması açıldığında otomatik olarak bağlanır.';
  }

  const tabCount = Number(status?.controllableTabCount ?? 0);
  $('tab-count').textContent = tabCount > 0 ? `${tabCount} sekme hazır` : 'Otomatik hazır';

  const active = status?.activeTab;
  if (!enabled) {
    $('context').textContent = 'Ajan erişimi kapalı';
  } else if (active?.supported && active?.host) {
    $('context').textContent = `Aktif sekme hazır · ${active.host}`;
  } else {
    $('context').textContent = 'Hazır — ajan komut gelince yeni sekme açabilir';
  }

  $('endpoint').textContent = `127.0.0.1:${port}`;
  const portInput = /** @type {HTMLInputElement} */ ($('port-input'));
  if (document.activeElement !== portInput) {
    portInput.value = String(port);
  }

  renderActivity(status?.recentActivity ?? []);
}

async function render() {
  const status = await send('status');
  applyStatus(status);
}

$('toggle').onclick = async () => {
  const enabled = lastStatus?.enabled !== false;
  const next = await send(enabled ? 'disconnect' : 'reconnect');
  applyStatus(next);
  setTimeout(() => void render(), 550);
};

$('clear-activity').onclick = async () => {
  const next = await send('clear_activity');
  applyStatus(next);
};

$('port-toggle').onclick = () => {
  const drawer = $('port-drawer');
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) {
    const input = /** @type {HTMLInputElement} */ ($('port-input'));
    input.focus();
    input.select();
  }
};

$('port-save').onclick = async () => {
  const input = /** @type {HTMLInputElement} */ ($('port-input'));
  const port = Number(input.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  const next = await send({ type: 'set_port', port });
  $('port-drawer').hidden = true;
  applyStatus(next);
};

$('open-options').onclick = () => {
  if (chrome.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
};

void render();
const poller = setInterval(() => void render(), 1500);
window.addEventListener('unload', () => clearInterval(poller));
