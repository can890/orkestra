// Orkestra ajanının aktif olarak kontrol ettiği sekmede gösterdiği zarif görsel gösterge.
// Tüm fonksiyonlar chrome.scripting.executeScript serileştirmesi için tamamen öz-yeterlidir
// (dış kapsama bağımlılığı yoktur) ve Shadow DOM kullanarak sayfa CSS'inden izole çalışır.

/**
 * Sayfada Orkestra yeşim kenar parıltısı ve yüzen "Orkestra kontrol ediyor" hapını gösterir.
 * @param {string} label
 * @param {number} [durationMs]
 */
export function showAgentOverlay(label = 'Çalışıyor', durationMs = 3600) {
  try {
    const HOST_ID = '__orkestra_agent_overlay__';
    const root = document.documentElement;
    if (!root) return;

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-orkestra-overlay', 'true');
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;transition:opacity 220ms ease;opacity:0;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          .frame {
            position: fixed;
            inset: 0;
            pointer-events: none;
            box-shadow: inset 0 0 0 3px rgba(16, 185, 129, 0.58), inset 0 0 24px rgba(16, 185, 129, 0.16);
          }
          .pill {
            position: fixed;
            left: 50%;
            bottom: 18px;
            transform: translateX(-50%);
            pointer-events: auto;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px 8px 13px;
            border-radius: 999px;
            background: rgba(17, 17, 17, 0.92);
            color: #ededed;
            border: 1px solid rgba(24, 184, 125, 0.42);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            letter-spacing: -0.01em;
            white-space: nowrap;
            user-select: none;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #18b87d;
            box-shadow: 0 0 0 3px rgba(24, 184, 125, 0.24);
            animation: ork-pulse 1.5s infinite;
            flex: none;
          }
          .brand {
            font-weight: 650;
            color: #ffffff;
          }
          .sep {
            color: rgba(255, 255, 255, 0.28);
          }
          .action {
            color: #bdbdbd;
            max-width: 210px;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .stop {
            margin-left: 2px;
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            background: rgba(255, 255, 255, 0.08);
            color: #f3f3f3;
            font: 600 11.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            cursor: pointer;
            transition: background 120ms ease, border-color 120ms ease;
          }
          .stop:hover {
            background: rgba(224, 86, 86, 0.24);
            border-color: rgba(224, 86, 86, 0.5);
            color: #ffb3b2;
          }
          @keyframes ork-pulse {
            0% { box-shadow: 0 0 0 0 rgba(24, 184, 125, 0.55); }
            70% { box-shadow: 0 0 0 6px rgba(24, 184, 125, 0); }
            100% { box-shadow: 0 0 0 0 rgba(24, 184, 125, 0); }
          }
        </style>
        <div class="frame" aria-hidden="true"></div>
        <div class="pill" role="status" aria-live="polite">
          <span class="dot" aria-hidden="true"></span>
          <span class="brand">Orkestra</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="action" id="ork-action"></span>
          <button type="button" class="stop" id="ork-stop">Duraklat</button>
        </div>
      `;
      const stopBtn = shadow.getElementById('ork-stop');
      if (stopBtn) {
        stopBtn.addEventListener('click', () => {
          host.style.opacity = '0';
          setTimeout(() => host.remove(), 220);
          try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
              void chrome.runtime.sendMessage({ type: 'disconnect' });
            }
          } catch {
            // yoksay
          }
        });
      }
      root.appendChild(host);
    }

    const actionEl = host.shadowRoot && host.shadowRoot.getElementById('ork-action');
    if (actionEl) actionEl.textContent = String(label || 'Çalışıyor');

    requestAnimationFrame(() => {
      host.style.opacity = '1';
    });

    const w = /** @type {any} */ (globalThis);
    if (w.__orkestraOverlayTimer) clearTimeout(w.__orkestraOverlayTimer);
    w.__orkestraOverlayTimer = setTimeout(() => {
      const current = document.getElementById(HOST_ID);
      if (!current) return;
      current.style.opacity = '0';
      setTimeout(() => {
        if (current.style.opacity === '0') current.remove();
      }, 240);
    }, Math.max(1200, Number(durationMs) || 3600));
  } catch {
    // Sayfa DOM erişimi kısıtlıysa sessizce atla.
  }
}

/** Ekran görüntüsü alınmadan hemen önce göstergeyi anında gizler. */
export function hideAgentOverlay() {
  try {
    const w = /** @type {any} */ (globalThis);
    if (w.__orkestraOverlayTimer) {
      clearTimeout(w.__orkestraOverlayTimer);
      w.__orkestraOverlayTimer = null;
    }
    const host = document.getElementById('__orkestra_agent_overlay__');
    if (host) host.remove();
  } catch {
    // yoksay
  }
}
