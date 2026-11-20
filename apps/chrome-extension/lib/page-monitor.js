// Orkestra Chrome köprüsü: sayfa başlangıcında (document_start, MAIN world) çalışan hafif
// konsol ve ağ izleyicisi. Sayfa işleyişini bozmaz; halka tamponda en fazla 200'er girdi tutar.

(function initOrkestraPageMonitor(root) {
  const MAX_ENTRIES = 200;
  const MAX_TEXT_LENGTH = 4000;

  function installOrkestraMonitor(win) {
    if (!win || typeof win !== 'object') return null;
    if (win.__orkestraMonitor && win.__orkestraMonitor.installed === true) {
      return win.__orkestraMonitor;
    }

    const state = {
      installed: true,
      console: [],
      network: [],
      seenResourceCount: 0,
      clearedAtPerfTime: 0,
    };

    function clipText(value) {
      const str = String(value ?? '');
      return str.length > MAX_TEXT_LENGTH ? `${str.slice(0, MAX_TEXT_LENGTH)}…` : str;
    }

    function formatArg(arg, seen) {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
        return String(arg);
      }
      if (arg instanceof Error) {
        return arg.stack || `${arg.name || 'Error'}: ${arg.message || ''}`;
      }
      if (typeof arg === 'object') {
        if (typeof arg.nodeType === 'number' && typeof arg.nodeName === 'string') {
          const id = arg.id ? `#${arg.id}` : '';
          return `<${String(arg.nodeName).toLowerCase()}${id}>`;
        }
        try {
          const visited = seen || new WeakSet();
          return JSON.stringify(arg, (_key, val) => {
            if (typeof val === 'bigint') return String(val);
            if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
            if (val && typeof val === 'object') {
              if (visited.has(val)) return '[Circular]';
              visited.add(val);
            }
            return val;
          });
        } catch {
          return Object.prototype.toString.call(arg);
        }
      }
      return String(arg);
    }

    function pushConsole(entry) {
      state.console.push(entry);
      if (state.console.length > MAX_ENTRIES) {
        state.console.splice(0, state.console.length - MAX_ENTRIES);
      }
    }

    function pushNetwork(entry) {
      state.network.push(entry);
      if (state.network.length > MAX_ENTRIES) {
        state.network.splice(0, state.network.length - MAX_ENTRIES);
      }
    }

    // 1. Console kancaları (log, info, warn, error)
    const consoleObj = win.console;
    if (consoleObj && typeof consoleObj === 'object') {
      for (const level of ['log', 'info', 'warn', 'error']) {
        const original = consoleObj[level];
        if (typeof original !== 'function') continue;
        try {
          const wrapped = function (...args) {
            try {
              const text = clipText(args.map((a) => formatArg(a)).join(' '));
              pushConsole({
                level,
                text,
                message: text,
                timestamp: Date.now(),
              });
            } catch {
              // İzleyici hatası sayfayı etkilemez.
            }
            return original.apply(this, args);
          };
          consoleObj[level] = wrapped;
        } catch {
          // Salt okunur console özelliği varsa atla.
        }
      }
    }

    // 2. Yakalanmamış hatalar (error & unhandledrejection)
    if (typeof win.addEventListener === 'function') {
      try {
        win.addEventListener(
          'error',
          (event) => {
            try {
              const err = event && event.error;
              const raw =
                (event && event.message) ||
                (err && (err.stack || err.message)) ||
                'Uncaught error';
              const text = clipText(raw);
              pushConsole({
                level: 'error',
                text,
                message: text,
                source: 'exception',
                url: (event && event.filename) || undefined,
                line: (event && event.lineno) || undefined,
                column: (event && event.colno) || undefined,
                timestamp: Date.now(),
              });
            } catch {
              // Yoksay
            }
          },
          true
        );
        win.addEventListener('unhandledrejection', (event) => {
          try {
            const reason = event ? event.reason : undefined;
            const text = clipText(`UnhandledRejection: ${formatArg(reason)}`);
            pushConsole({
              level: 'error',
              text,
              message: text,
              source: 'unhandledrejection',
              timestamp: Date.now(),
            });
          } catch {
            // Yoksay
          }
        });
      } catch {
        // Yoksay
      }
    }

    // 3. Fetch kancası
    if (typeof win.fetch === 'function') {
      const originalFetch = win.fetch;
      try {
        win.fetch = function (...args) {
          const startedAt = Date.now();
          let url = '';
          let method = 'GET';
          try {
            const [input, init] = args;
            if (typeof input === 'string') {
              url = input;
            } else if (input && typeof input === 'object') {
              url = String(input.url || input.href || '');
              if (typeof input.method === 'string') method = input.method.toUpperCase();
            }
            if (init && typeof init.method === 'string') {
              method = init.method.toUpperCase();
            }
          } catch {
            // Yoksay
          }

          const promise = originalFetch.apply(this, args);
          if (promise && typeof promise.then === 'function') {
            promise.then(
              (response) => {
                try {
                  const durationMs = Math.max(0, Date.now() - startedAt);
                  pushNetwork({
                    url: clipText(url || (response && response.url) || ''),
                    method,
                    status: response && typeof response.status === 'number' ? response.status : 0,
                    statusText:
                      response && typeof response.statusText === 'string'
                        ? response.statusText
                        : '',
                    ok: Boolean(response && response.ok),
                    type: 'fetch',
                    durationMs,
                    duration: durationMs,
                    timestamp: startedAt,
                  });
                } catch {
                  // Yoksay
                }
              },
              (error) => {
                try {
                  const durationMs = Math.max(0, Date.now() - startedAt);
                  pushNetwork({
                    url: clipText(url),
                    method,
                    status: 0,
                    ok: false,
                    type: 'fetch',
                    error: clipText(error instanceof Error ? error.message : String(error)),
                    durationMs,
                    duration: durationMs,
                    timestamp: startedAt,
                  });
                } catch {
                  // Yoksay
                }
              }
            );
          }
          return promise;
        };
      } catch {
        // Yoksay
      }
    }

    // 4. XMLHttpRequest kancası
    const XHR = win.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      if (typeof origOpen === 'function' && typeof origSend === 'function') {
        try {
          XHR.prototype.open = function (method, url, ...rest) {
            try {
              this.__orkestraXhr = {
                method: typeof method === 'string' ? method.toUpperCase() : 'GET',
                url: clipText(url),
              };
            } catch {
              // Yoksay
            }
            return origOpen.call(this, method, url, ...rest);
          };
          XHR.prototype.send = function (...args) {
            const meta = this.__orkestraXhr;
            const startedAt = Date.now();
            if (meta && typeof this.addEventListener === 'function') {
              const record = (errText) => {
                try {
                  const durationMs = Math.max(0, Date.now() - startedAt);
                  const status = typeof this.status === 'number' ? this.status : 0;
                  pushNetwork({
                    url: clipText(this.responseURL || meta.url || ''),
                    method: meta.method || 'GET',
                    status,
                    statusText: typeof this.statusText === 'string' ? this.statusText : '',
                    ok: status >= 200 && status < 400,
                    type: 'xhr',
                    ...(errText ? { error: errText } : {}),
                    durationMs,
                    duration: durationMs,
                    timestamp: startedAt,
                  });
                } catch {
                  // Yoksay
                }
              };
              this.addEventListener('load', () => record(''), { once: true });
              this.addEventListener('error', () => record('Network error'), { once: true });
              this.addEventListener('abort', () => record('Aborted'), { once: true });
              this.addEventListener('timeout', () => record('Timeout'), { once: true });
            }
            return origSend.apply(this, args);
          };
        } catch {
          // Yoksay
        }
      }
    }

    // 5. PerformanceResourceTiming geri doldurma & PerformanceObserver
    function ingestResourceEntry(entry) {
      if (!entry || typeof entry.name !== 'string') return;
      if (typeof entry.startTime === 'number' && entry.startTime < state.clearedAtPerfTime) {
        return;
      }
      const initiator = String(entry.initiatorType || 'resource').toLowerCase();
      // Fetch ve XHR zaten kendi kancalarından durum/metot bilgisiyle kaydedilir;
      // yalnız kancadan önce gerçekleşmiş olanları veya statik kaynakları ekle.
      const url = clipText(entry.name);
      const exists = state.network.some((item) => item.url === url);
      if (exists && (initiator === 'fetch' || initiator === 'xmlhttprequest')) return;
      const durationMs =
        typeof entry.duration === 'number' && Number.isFinite(entry.duration)
          ? Math.max(0, Math.round(entry.duration))
          : 0;
      const status =
        typeof entry.responseStatus === 'number' && entry.responseStatus > 0
          ? entry.responseStatus
          : 200;
      pushNetwork({
        url,
        method: 'GET',
        status,
        ok: status >= 200 && status < 400,
        type: initiator,
        durationMs,
        duration: durationMs,
        timestamp: Date.now(),
      });
    }

    state.syncPerformanceResources = function syncPerformanceResources() {
      try {
        if (!win.performance || typeof win.performance.getEntriesByType !== 'function') return;
        const entries = win.performance.getEntriesByType('resource') || [];
        for (let i = state.seenResourceCount; i < entries.length; i += 1) {
          ingestResourceEntry(entries[i]);
        }
        state.seenResourceCount = entries.length;
      } catch {
        // Yoksay
      }
    };

    state.syncPerformanceResources();

    if (typeof win.PerformanceObserver === 'function') {
      try {
        const observer = new win.PerformanceObserver((list) => {
          try {
            const entries = list.getEntries ? list.getEntries() : [];
            for (const entry of entries) ingestResourceEntry(entry);
          } catch {
            // Yoksay
          }
        });
        observer.observe({ type: 'resource', buffered: true });
      } catch {
        // Yoksay
      }
    }

    win.__orkestraMonitor = state;
    return state;
  }

  root.__orkestraInstallMonitor = installOrkestraMonitor;
  installOrkestraMonitor(root);
})(typeof globalThis !== 'undefined' ? globalThis : window);
