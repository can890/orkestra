#!/usr/bin/env node
/**
 * Orkestra'nın derlenmiş paketlerindeki (out/) sabit İngilizce metinleri, kod yapısını koruyarak
 * ui-tr.json sözlüğüyle Türkçeye çevirir. `pnpm run build` sonunda `pnpm run localize` ile çalışır.
 *
 * Kullanım:
 *   node tooling/localization/patch-tr.cjs <out-dizini> <sözlük.json>
 *
 * Ortam değişkenleri:
 *   ORKESTRA_L10N_ALLOW_MISSES=1
 *     Zorunlu sabit yamalardan biri (ör. bildirim sesi seçimi, cron dili, toast takma adı tespiti)
 *     hiç eşleşmezse betik hiçbir dosyaya yazmadan sıfır olmayan kodla çıkar; böylece paketleyici
 *     adlarının değişmesi sessizce İngilizce arayüz üretmez. Bu değişken eksikleri yalnızca uyarı
 *     olarak yazdırıp yamaya devam etmeyi sağlar (geçici kaçış kapısı; kalıcı çözüm yamayı
 *     güncellemektir).
 *   ORKESTRA_L10N_MISSING_REPORT=<dosya>
 *     Çevrilebilir bir konumda olduğu hâlde sözlükte karşılığı olmayan İngilizce metinleri JSON
 *     olarak bu dosyaya yazar (sözlüğe eklenecek metinleri bulmak için).
 *
 * Çeviri konumları iki katmanlıdır:
 *   A — kesin arayüz konumları (JSX çocukları/öznitelikleri, toast çağrıları, devre dışı nedenleri,
 *       etiket tabloları…): sözlükteki her anahtar çevrilir.
 *   B — geniş konumlar (dönüş değerleri, hata nesneleri, değişkenler, bilinmeyen çağrı argümanları):
 *       yalnızca cümle benzeri (en az iki sözcüklü) anahtarlar ve paketlerin hiçbir yerinde
 *       karşılaştırma/arama anahtarı olarak kullanılmayan metinler çevrilir. Ana süreçte yalnızca
 *       arayüze `error.message` ile ulaşan konumlar (hata nesneleri, message/error/reason alanları)
 *       B katmanına girer.
 *
 * Sözlükte `@attr:` önekli anahtarlar yalnızca HTML/Solid şablon özniteliklerinde aranır
 * (ör. `aria-label=error` için "@attr:error"); böylece tek sözcüklü öznitelik değerleri kod
 * içindeki aynı metinlerle çakışmaz.
 *
 * Testler: node --test tooling/localization/patch-tr.test.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const localRequire = createRequire(
  path.resolve(__dirname, '../../apps/orkestra-desktop/package.json')
);
const ts = localRequire('typescript');

const ALLOW_MISSES_ENV = 'ORKESTRA_L10N_ALLOW_MISSES';
const MISSING_REPORT_ENV = 'ORKESTRA_L10N_MISSING_REPORT';

// Konumundan bağımsız olarak her zaman çevrilen güncelleme/diff durum metinleri.
const UI_STATUS_KEYS = new Set([
  "You're up to date",
  'Update ready to install',
  'An update is available',
  'Current ${0} version v${1} is up to date',
  'Version v${0} is available. Update and restart ${1} to use the new version',
  'Version v${0} is available. Download and restart ${1} to use the new version',
  'Restart ${0} to use the new version',
  '${0} lines added',
  '${0} lines removed',
  'Update request failed with HTTP ${0}',
]);
// Değeri ekranda görünen JSX/bileşen özellikleri.
const UI_PROPS = new Set([
  'children',
  'title',
  'label',
  'placeholder',
  'searchPlaceholder',
  'description',
  'aria-label',
  'ariaLabel',
  'aria-description',
  'tooltip',
  'emptyMessage',
  'detail',
  'buttonLabel',
  'confirmLabel',
  'cancelLabel',
  'loadingText',
  'emptyText',
  'errorMessage',
  'helperText',
  'alt',
  'heading',
  'subtitle',
  'text',
  'name',
  'buttons',
  'defaultLabel',
  'loadingLabel',
  'actionLabel',
  'disabledReason',
]);
const CHAT_LABELS = new Set([
  'Thinking',
  'Thinking ${0}s',
  'Thought briefly',
  'Thought for ${0}s',
  'Thought',
  'Working...',
  'Working…',
]);
// Yalnızca renderer paketlerinde arayüz metni taşıyan alanlar (ana süreçte kimlik olabilirler).
const RENDERER_UI_PROPS = new Set(['category', 'primary', 'secondary']);
// `modalLabel`, `emptyTitle` gibi bileşik adlı görünen metin alanları (renderer).
const RENDERER_UI_PROP_SUFFIX =
  /[a-z](?:Label|Title|Description|Tooltip|Placeholder|Heading|Hint|Message|Caption)$/;
// toast seçeneklerinde görünen metin taşıyan alanlar (toast.promise yükleme/sonuç metinleri dahil).
const TOAST_OPTION_PROPS = new Set([
  'description',
  'title',
  'label',
  'loading',
  'success',
  'error',
]);
const TOAST_METHODS = new Set([
  'success',
  'error',
  'info',
  'warning',
  'message',
  'loading',
  'custom',
  'promise',
]);
// Atandığında ekranda görünen DOM özellikleri.
const UI_ASSIGN_PROPS = new Set([
  'title',
  'textContent',
  'innerText',
  'placeholder',
  'ariaLabel',
  'alt',
  'label',
]);
// HTML ve Solid şablonlarında çevrilen öznitelikler.
const UI_HTML_ATTRS = new Set([
  'title',
  'aria-label',
  'placeholder',
  'alt',
  'aria-description',
  'aria-placeholder',
]);
// Değeri kimlik/anahtar olarak kullanılan alanlar: geniş katman bunlara dokunmaz.
const IDENTITY_PROPS = new Set([
  'id',
  'key',
  'type',
  'kind',
  'value',
  'command',
  'event',
  'action',
  'channel',
  'code',
  'variant',
  'status',
  'state',
  'mode',
  'role',
  'slug',
  'path',
  'url',
  'href',
  'src',
  'icon',
  'className',
  'style',
  'method',
  'provider',
  'scope',
  'source',
  'target',
  'tag',
  'testId',
  'data-testid',
  'initialPrompt',
  'prompt',
  'systemPrompt',
]);
// Ana süreçte arayüze `error.message` ile ulaşan alanlar.
const MAIN_MESSAGE_PROPS = new Set(['message', 'error', 'reason', 'errorMessage']);
// Değeri metin olarak karşılaştırılan/arandığı çağrılar: ilk argüman mantık anahtarıdır.
const LOGIC_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'get',
  'has',
  'set',
  'delete',
  'getItem',
  'setItem',
  'removeItem',
]);
const LOGGER_METHODS = new Set([
  'log',
  'debug',
  'info',
  'warn',
  'error',
  'trace',
  'fatal',
  'verbose',
  'silly',
]);
const LOGGER_OBJECT = /(?:^|\.)_?(?:console|logger|log|[a-z]\w*Logger)$/;
const TOAST_NAME = /^_?toast\w*$/i;
const SETTER_NAME = /^set\w*(?:Error|Message|Notice|Warning|Hint|Reason)$/;
const DISABLED_NAME = /^disabled(?:\$\d+)?$/;
const CREATE_ELEMENT = /(?:^|\.)(?:createElement|jsxs?|jsxDEV)$/;
const NON_DISPLAY_CALL =
  /(?:^|\.)(?:require|Symbol|for|RegExp|querySelector(?:All)?|getElementById|addEventListener|removeEventListener|postMessage|invoke|send|emit|on|once|off|fetch|parse|stringify|join|resolve|normalize|dirname|basename|extname|relative|exec|spawn|execFile|matchMedia|getPropertyValue|setProperty|replace|replaceAll|split|match|matchAll|search|test|localeCompare)$/;
const DISPLAY_NAME = /(?:label|title|description|tooltip|placeholder|heading|hint|Text)$/i;
const DISPLAY_FN = /(?:label|title|description|message|tooltip|placeholder|heading|hint|Text)/i;
const MESSAGE_NAME = /(?:message|msg|error|reason|detail|caption|warning|notice)$/i;
const MESSAGE_FN = /(?:error|detail|reason|caption|notice|warning)/i;
const MESSAGE_CALLEE = /(?:Message|Error|Reason)$/;
// Ad, tam sözcük olarak (labels, mergeLabels, CREATION_STAGE_LABELS) etiket tablosunu anlatmalı;
// `contexts` ya da `objCopy` gibi rastlantısal sonekler eşleşmez.
const LABEL_WORDS =
  'Labels?|Titles?|Descriptions?|Messages?|Texts?|Hints?|Reasons?|Tooltips?|Placeholders?|Captions?|Headings?';
const LABEL_MAP_NAME = new RegExp(
  `(?:^(?:${LABEL_WORDS.toLowerCase()})|[a-z0-9](?:${LABEL_WORDS})|_(?:${LABEL_WORDS.toUpperCase()}))$`
);
// Yeni konumlar (parametre, yapı bozma, sınıf alanı, atama) için tam sözcüklü görünen metin adı.
const DISPLAY_WORDS = 'Label|Title|Description|Tooltip|Placeholder|Heading|Hint|Text';
const DISPLAY_NAME_STRICT = new RegExp(
  `(?:^(?:${DISPLAY_WORDS.toLowerCase()})|[a-z0-9](?:${DISPLAY_WORDS})|_(?:${DISPLAY_WORDS.toUpperCase()}))$`
);
const TEMPLATE_FN = /^(?:_\$)?template(?:\$\d+|\d+)?$/;
const CRONSTRUE_NAME = /^cronstrue(?:\$\d+|\d+)?$/;
const SHUTDOWN_IMPACT_NAME = /^describeShutdownImpact(?:\$\d+|\d+)?$/;
const NATIVE_MENU_LABELS = {
  services: 'Hizmetler',
  hide: 'Gizle',
  hideOthers: 'Diğerlerini gizle',
  unhide: 'Tümünü göster',
  cut: 'Kes',
  copy: 'Kopyala',
  paste: 'Yapıştır',
  pasteAndMatchStyle: 'Biçimi eşleştirerek yapıştır',
  delete: 'Sil',
  selectAll: 'Tümünü seç',
  reload: 'Yeniden yükle',
  forceReload: 'Zorla yeniden yükle',
  toggleDevTools: 'Geliştirici araçları',
  resetZoom: 'Gerçek boyut',
  zoomIn: 'Yakınlaştır',
  zoomOut: 'Uzaklaştır',
  togglefullscreen: 'Tam ekran',
  windowMenu: 'Pencere',
  minimize: 'Simge durumuna küçült',
  zoom: 'Büyüt',
  front: 'Tümünü öne getir',
};
const SOUND_FOCUS_LABELS = { unfocused: 'Yalnızca odakta değilken', always: 'Her zaman' };

/** Zorunlu sabit yamalar: her biri derleme başına en az bir kez uygulanmış olmalıdır. */
const REQUIRED_PATCHES = {
  'toast-alias': 'Renderer paketinde toast işlevi (ve takma adı) bulunamadı',
  'project-expand-label': 'Proje daralt/genişlet etiketi şablonu bulunamadı',
  'agents-section-installed': 'AGENTS_SECTION_INSTALLED sabiti bulunamadı',
  'agents-section-recommended': 'AGENTS_SECTION_RECOMMENDED sabiti bulunamadı',
  'agents-section-not-installed': 'AGENTS_SECTION_NOT_INSTALLED sabiti bulunamadı',
  'notification-sound-select': 'Bildirim sesi zamanlaması Select.Value bileşeni bulunamadı',
  'shutdown-impact': 'describeShutdownImpact işlevi bulunamadı',
  'cron-locale-call': 'cronstrue.toString çağrısı bulunamadı',
  'cron-locale-module': 'cronstrue Türkçe dil modülü eklenemedi',
  'native-menu-labels': 'Yerel menü rolleri (role: "copy" …) bulunamadı',
  'recovery-html': 'Kurtarma sayfası HTML şablonu bulunamadı',
};

const SHUTDOWN_IMPACT_BODY = `(summary) {
        const localAgents = summary.acpSessions + summary.localTuiSessions;
        const impacts = [];
        if (localAgents > 0) impacts.push(localAgents + ' çalışan ajan oturumu');
        if (summary.terminals > 0) impacts.push(summary.terminals + ' terminal');
        const prefix = summary.incomplete ? 'En az ' : '';
        const stopped = impacts.length ? prefix + impacts.join(' ve ') + ' durdurulabilir.' : summary.incomplete ? 'Çalışan ajan oturumları ve terminaller durdurulabilir.' : 'Arka plan hizmetleri ve otomasyonlar duracak.';
        const remote = summary.remoteSessions > 0 ? ' ' + prefix + summary.remoteSessions + ' uzak oturum çalışmaya devam edecek.' : '';
        return stopped + remote;
      }`;

function createStats() {
  return { fixed: {}, rules: {}, missing: new Map(), logicSkipped: new Set() };
}

function bump(stats, bucket, id, amount = 1) {
  if (!stats) return;
  stats[bucket][id] = (stats[bucket][id] ?? 0) + amount;
}

function isRendererFile(file) {
  return /(?:^|[\\/])renderer(?:[\\/]|$)/.test(file);
}

function isStringLike(node) {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

/** Bir metin düğümünün sözlük anahtarı; şablon ifadelerinde ${0}, ${1}… yer tutucularıyla. */
function keyOf(node) {
  return ts.isTemplateExpression(node)
    ? node.head.text +
        node.templateSpans.map((span, index) => '${' + index + '}' + span.literal.text).join('')
    : node.text;
}

function propName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** En az iki sözcüklü, kod gibi görünmeyen metin: geniş katmanda çevrilebilir. */
function isSentenceLike(key) {
  const plain = key.replace(/\$\{\d+\}/g, 'X');
  if (plain.length < 6 || /[{}<>=;\\`|]/.test(plain) || /^(?:https?:|\/|\.\/|~)/.test(plain)) {
    return false;
  }
  // Yer tutucular sözcük sayılmaz: "Title: ${0}" gibi etiket satırları cümle değildir.
  const words = key
    .replace(/\$\{\d+\}/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => /[A-Za-z]/.test(word));
  return (
    /^[A-Z0-9"'“(]/.test(plain) &&
    words.length >= 2 &&
    words.some((word) => /[A-Za-z]{2,}/.test(word))
  );
}

function looksEnglish(key) {
  const plain = key.replace(/\$\{\d+\}/g, '');
  if (!/[A-Za-z]{3,}/.test(plain) || /[çğıöşüÇĞİÖŞÜ]/.test(plain)) return false;
  if (/[{}<>=;\\`]|^\s*$|^https?:|^[a-z0-9_.:\-/#@]+$|^[A-Z0-9_]+$/.test(plain)) return false;
  return /^[A-Z]/.test(plain.trim()) || /\s/.test(plain.trim());
}

/** Sözlükte yalnızca kendi anahtarlarını arar ("constructor" gibi prototip adlarını değil). */
function lookup(dict, key) {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

function placeholders(text) {
  return [...text.matchAll(/\$\{(\d+)\}/g)]
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b)
    .join(',');
}

/** Sözlüğü okur ve yer tutucuları anahtarla uyuşmayan girdileri reddeder. */
function loadDictionary(dictFile) {
  const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
  const problems = [];
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== 'string') problems.push(`${key}: çeviri metin değil`);
    else if (placeholders(key) !== placeholders(value))
      problems.push(`${key}: yer tutucular uyuşmuyor`);
  }
  if (problems.length) throw new Error('Sözlük geçersiz:\n  ' + problems.join('\n  '));
  return dict;
}

// ---------------------------------------------------------------------------------------------
// Ön tarama: toast takma adları, dışa/içe aktarımlar ve mantıkta kullanılan metinler.
// ---------------------------------------------------------------------------------------------

function objectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return new Set();
  return new Set(node.properties.map((property) => propName(property.name)).filter(Boolean));
}

/** `X = Object.assign(fn, { success, error, dismiss|promise, … })` biçimindeki toast tanımı mı? */
function isToastDefinition(init, sf) {
  if (!init || !ts.isCallExpression(init) || init.expression.getText(sf) !== 'Object.assign') {
    return false;
  }
  return init.arguments.slice(1).some((arg) => {
    const keys = objectKeys(arg);
    return keys.has('success') && keys.has('error') && (keys.has('dismiss') || keys.has('promise'));
  });
}

function collectFacts(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const facts = { toastDefs: new Set(), exports: new Map(), imports: [], logic: new Set() };
  const addLogic = (node) => {
    if (isStringLike(node)) facts.logic.add(node.text);
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isToastDefinition(node.initializer, sf)
    ) {
      facts.toastDefs.add(node.name.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const spec of node.exportClause.elements) {
        facts.exports.set(spec.name.text, (spec.propertyName ?? spec.name).text);
      }
    } else if (ts.isImportDeclaration(node) && isStringLike(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) {
          facts.imports.push({
            from: node.moduleSpecifier.text,
            imported: (spec.propertyName ?? spec.name).text,
            local: spec.name.text,
          });
        }
      }
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        addLogic(node.left);
        addLogic(node.right);
      } else if (op === ts.SyntaxKind.InKeyword) {
        addLogic(node.left);
      }
    } else if (ts.isCaseClause(node)) {
      addLogic(node.expression);
    } else if (ts.isElementAccessExpression(node)) {
      addLogic(node.argumentExpression);
    } else if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      addLogic(node.name);
    } else if (ts.isComputedPropertyName(node)) {
      addLogic(node.expression);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (LOGIC_METHODS.has(node.expression.name.text)) addLogic(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** Toast takma adlarını dosyalar arası içe/dışa aktarımlar üzerinden çözer. */
function resolveToastAliases(factsByFile) {
  const aliases = new Map();
  for (const [file, facts] of factsByFile) aliases.set(file, new Set(facts.toastDefs));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, facts] of factsByFile) {
      for (const { from, imported, local } of facts.imports) {
        if (!from.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), from);
        const targetFacts = factsByFile.get(target);
        const targetLocal = targetFacts?.exports.get(imported);
        if (targetLocal && aliases.get(target)?.has(targetLocal) && !aliases.get(file).has(local)) {
          aliases.get(file).add(local);
          changed = true;
        }
      }
    }
  }
  return aliases;
}

// ---------------------------------------------------------------------------------------------
// Konum sınıflandırması.
// ---------------------------------------------------------------------------------------------

function isToastCallee(expr, ctx) {
  if (ts.isIdentifier(expr)) return ctx.toastAliases.has(expr.text) || TOAST_NAME.test(expr.text);
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (TOAST_NAME.test(expr.name.text)) return true;
  const target = expr.expression;
  return (
    ts.isIdentifier(target) &&
    TOAST_METHODS.has(expr.name.text) &&
    (ctx.toastAliases.has(target.text) || /^toast\w*$/.test(target.text))
  );
}

function isToastArgument(objectLiteral, ctx) {
  const call = objectLiteral.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    call.arguments.includes(objectLiteral) &&
    isToastCallee(call.expression, ctx)
  );
}

/** `const mergeLabels = { merge: '…' }` gibi etiket tablolarının değerleri arayüz metnidir. */
function isLabelMap(objectLiteral) {
  let node = objectLiteral.parent;
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      (ts.isCallExpression(node) && /^Object\.freeze$/.test(node.expression.getText())))
  ) {
    node = node.parent;
  }
  if (!node) return false;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
    return LABEL_MAP_NAME.test(node.name.text);
  if (ts.isPropertyAssignment(node)) return LABEL_MAP_NAME.test(propName(node.name) ?? '');
  return false;
}

function enclosingFunctionName(node) {
  let fn = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return undefined;
  if (fn.name) return propName(fn.name);
  let holder = fn.parent;
  while (holder && ts.isParenthesizedExpression(holder)) holder = holder.parent;
  if (!holder) return undefined;
  if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder))
    return propName(holder.name);
  if (ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return calleeName(holder.left);
  }
  return undefined;
}

function isLoggerCallee(expr, sf) {
  return (
    ts.isPropertyAccessExpression(expr) &&
    LOGGER_METHODS.has(expr.name.text) &&
    LOGGER_OBJECT.test(expr.expression.getText(sf))
  );
}

function classifyCallArgument(call, child, ctx, renderer, sf) {
  const index = call.arguments.indexOf(child);
  if (index < 0) return null;
  const callee = call.expression;
  const text = callee.getText(sf);
  const name = calleeName(callee) ?? '';
  if (isToastCallee(callee, ctx)) return { tier: 'A', rule: 'toast' };
  if (/^(?:window\.|globalThis\.)?(?:alert|confirm)$/.test(text))
    return { tier: 'A', rule: 'dialog' };
  if (SETTER_NAME.test(name)) return { tier: 'A', rule: 'setter' };
  if (DISABLED_NAME.test(name)) return { tier: 'A', rule: 'disabled-reason' };
  if (
    name === 'setAttribute' &&
    index === 2 &&
    isStringLike(call.arguments[1]) &&
    UI_HTML_ATTRS.has(call.arguments[1].text)
  ) {
    return { tier: 'A', rule: 'attribute' };
  }
  if (CREATE_ELEMENT.test(text) && index >= 2) return { tier: 'A', rule: 'element-child' };
  if (isLoggerCallee(callee, sf) || NON_DISPLAY_CALL.test(text)) return null;
  if (MESSAGE_CALLEE.test(name)) return { tier: 'B', rule: 'message-call' };
  return renderer ? { tier: 'B', rule: 'call-argument' } : null;
}

/**
 * Bir metin düğümünün çeviri konumunu sınıflandırır: `{ tier: 'A' | 'B', rule }` ya da null
 * (kod/mantık konumu, dokunulmaz).
 */
function classifyLiteral(node, file, ctx = {}, sf = node.getSourceFile()) {
  const options = { toastAliases: new Set(), ...ctx };
  const renderer = isRendererFile(file);
  const broad = (rule) => (renderer ? { tier: 'B', rule } : null);
  const chatLabel = renderer && CHAT_LABELS.has(keyOf(node));
  let child = node;
  for (let depth = 0; depth < 16 && child.parent; depth++, child = child.parent) {
    const parent = child.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isAwaitExpression(parent)
    ) {
      continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition === child) return null;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        continue;
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child) continue;
      if (op === ts.SyntaxKind.EqualsToken && parent.right === child) {
        const target = parent.left;
        const targetName = calleeName(target) ?? '';
        if (ts.isPropertyAccessExpression(target) && UI_ASSIGN_PROPS.has(targetName)) {
          return { tier: 'A', rule: 'assignment' };
        }
        if (DISPLAY_NAME_STRICT.test(targetName)) return { tier: 'A', rule: 'assignment' };
        if (MESSAGE_NAME.test(targetName)) return { tier: 'B', rule: 'assignment' };
        return broad('assignment');
      }
      return null;
    }
    if (
      ts.isPrefixUnaryExpression(parent) ||
      ts.isTypeOfExpression(parent) ||
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTaggedTemplateExpression(parent) ||
      ts.isCaseClause(parent) ||
      ts.isComputedPropertyName(parent) ||
      ts.isExpressionStatement(parent) ||
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent)
    ) {
      return null;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (parent.name === child) return null;
      const key = propName(parent.name);
      if (key === undefined) return null;
      if (key === 'message')
        return renderer ? { tier: 'A', rule: 'prop' } : { tier: 'B', rule: 'main-message' };
      if (UI_PROPS.has(key)) return { tier: 'A', rule: 'prop' };
      if (renderer && (RENDERER_UI_PROPS.has(key) || RENDERER_UI_PROP_SUFFIX.test(key))) {
        return { tier: 'A', rule: 'prop' };
      }
      const objectLiteral = parent.parent;
      if (TOAST_OPTION_PROPS.has(key) && isToastArgument(objectLiteral, options)) {
        return { tier: 'A', rule: 'toast' };
      }
      if (IDENTITY_PROPS.has(key)) return null;
      if (isLabelMap(objectLiteral)) return { tier: 'A', rule: 'label-map' };
      if (MAIN_MESSAGE_PROPS.has(key) || MESSAGE_NAME.test(key))
        return { tier: 'B', rule: 'message-prop' };
      return broad('prop');
    }
    if (ts.isCallExpression(parent)) {
      if (parent.expression === child) return null;
      return classifyCallArgument(parent, child, options, renderer, sf);
    }
    if (ts.isNewExpression(parent)) {
      const name = calleeName(parent.expression) ?? '';
      // `new WireError(code, message)` gibi özel hata sınıfları mesajı ilk argümanda taşımayabilir.
      if (/Error$/.test(name) && parent.arguments?.includes(child)) {
        return { tier: 'B', rule: 'error' };
      }
      return null;
    }
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyDeclaration(parent)
    ) {
      if (parent.initializer !== child) return null;
      if (chatLabel && ts.isVariableDeclaration(parent)) return { tier: 'A', rule: 'chat-label' };
      const bindingName = ts.isBindingElement(parent) ? propName(parent.propertyName) : undefined;
      const name = bindingName ?? propName(parent.name) ?? '';
      // Değişken adları eski (gevşek) kalıpla, diğer bağlamalar tam sözcüklü kalıpla eşleşir.
      const displayName = ts.isVariableDeclaration(parent) ? DISPLAY_NAME : DISPLAY_NAME_STRICT;
      if (displayName.test(name)) return { tier: 'A', rule: 'variable' };
      if (MESSAGE_NAME.test(name)) return { tier: 'B', rule: 'variable' };
      return broad('variable');
    }
    if (ts.isReturnStatement(parent)) {
      const name = enclosingFunctionName(parent) ?? '';
      if (DISPLAY_FN.test(name)) return { tier: 'A', rule: 'return' };
      if (MESSAGE_FN.test(name)) return { tier: 'B', rule: 'return' };
      return broad('return');
    }
    if (ts.isArrowFunction(parent)) {
      if (chatLabel) return { tier: 'A', rule: 'chat-label' };
      if (parent.body !== child) return null;
      continue;
    }
    if (ts.isFunctionLike(parent)) return chatLabel ? { tier: 'A', rule: 'chat-label' } : null;
    if (ts.isThrowStatement(parent)) return broad('throw');
    if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isIfStatement(parent)) return null;
  }
  return null;
}

/** Eski API: metin bir arayüz konumunda mı? (Denetim betikleri kullanır.) */
function isDisplayLiteral(node, file, ctx) {
  return classifyLiteral(node, file, ctx) !== null;
}

// ---------------------------------------------------------------------------------------------
// Yama.
// ---------------------------------------------------------------------------------------------

function translatedExpression(node, translation, source) {
  if (!ts.isTemplateExpression(node)) return JSON.stringify(translation);
  const spans = [...translation.matchAll(/\$\{(\d+)\}/g)].map((m) => Number(m[1]));
  if (
    spans.length !== node.templateSpans.length ||
    new Set(spans).size !== node.templateSpans.length ||
    spans.some((i) => i >= node.templateSpans.length)
  ) {
    throw new Error('Çeviri yer tutucuları eşleşmiyor: ' + keyOf(node));
  }
  const pieces = [];
  let end = 0;
  for (const match of translation.matchAll(/\$\{(\d+)\}/g)) {
    pieces.push(JSON.stringify(translation.slice(end, match.index)));
    pieces.push('__orkestra' + Number(match[1]));
    end = match.index + match[0].length;
  }
  pieces.push(JSON.stringify(translation.slice(end)));
  const args = node.templateSpans.map(
    (span) => 'String(' + source.slice(span.expression.getStart(), span.expression.end) + ')'
  );
  return (
    '((' +
    args.map((_, i) => '__orkestra' + i).join(',') +
    ') => (' +
    pieces.join(' + ') +
    '))(' +
    args.join(',') +
    ')'
  );
}

/** Metin düzeyindeki sabit yamalar; takma ad değişikliklerine karşı ad kalıplarıyla eşleşir. */
const TEXT_PATCHES = [
  {
    id: 'project-expand-label',
    find: /`\$\{([\w$]+) \? "Collapse" : "Expand"\} \$\{([\w$]+)\}`/g,
    replace: '`${$2} — ${$1 ? "Daralt" : "Genişlet"}`',
    applied: /`\$\{[\w$]+\} — \$\{[\w$]+ \? "Daralt" : "Genişlet"\}`/g,
  },
  {
    id: 'agents-section-installed',
    find: /((?:const|let|var) AGENTS_SECTION_INSTALLED(?:\$\d+)? = )"Installed"/g,
    replace: '$1"Kurulu"',
    applied: /(?:const|let|var) AGENTS_SECTION_INSTALLED(?:\$\d+)? = "Kurulu"/g,
  },
  {
    id: 'agents-section-recommended',
    find: /((?:const|let|var) AGENTS_SECTION_RECOMMENDED(?:\$\d+)? = )"Recommended"/g,
    replace: '$1"Önerilen"',
    applied: /(?:const|let|var) AGENTS_SECTION_RECOMMENDED(?:\$\d+)? = "Önerilen"/g,
  },
  {
    id: 'agents-section-not-installed',
    find: /((?:const|let|var) AGENTS_SECTION_NOT_INSTALLED(?:\$\d+)? = )"Not installed"/g,
    replace: '$1"Kurulu değil"',
    applied: /(?:const|let|var) AGENTS_SECTION_NOT_INSTALLED(?:\$\d+)? = "Kurulu değil"/g,
  },
  {
    // Eski yamaların yanlışlıkla çevirdiği komut kimliğini geri alır (zorunlu değil).
    id: 'continue-command-name',
    find: /(id: "continue",\s*name: )"Devam et"/g,
    replace: '$1"Continue"',
  },
];

function applyTextPatches(source, stats) {
  let result = source;
  for (const patch of TEXT_PATCHES) {
    const applied = patch.applied ? (result.match(patch.applied) ?? []).length : 0;
    let count = 0;
    result = result.replace(patch.find, (...args) => {
      count++;
      return patch.replace.replace(/\$(\d)/g, (_, i) => args[Number(i)]);
    });
    if (count + applied) bump(stats, 'fixed', patch.id, count + applied);
  }
  return result;
}

/** jsx/jsxs çağrısının ilk argümanı `<X>.<part>` mı? */
function jsxPart(call, part, sf) {
  if (!ts.isCallExpression(call) || !/(?:^|\.)jsxs?$/.test(call.expression.getText(sf)))
    return undefined;
  const component = call.arguments[0];
  if (!component || !ts.isPropertyAccessExpression(component) || component.name.text !== part)
    return undefined;
  return component.expression.getText(sf);
}

/** Bildirim sesi zamanlaması Select'i ham değeri ("always") göstermesin diye Value'ya etiket verir. */
function soundFocusSelectEdits(node, sf, edits, stats) {
  const owner = jsxPart(node, 'Root', sf);
  const props = node.arguments?.[1];
  if (!owner || !props || !ts.isObjectLiteralExpression(props)) return;
  const valueProp = props.properties.find(
    (p) => ts.isPropertyAssignment(p) && propName(p.name) === 'value'
  );
  if (!valueProp || !valueProp.initializer.getText(sf).includes('soundFocusMode')) return;
  const valueText = valueProp.initializer.getText(sf);
  const visit = (inner) => {
    if (
      jsxPart(inner, 'Value', sf) === owner &&
      inner.arguments[1] &&
      ts.isObjectLiteralExpression(inner.arguments[1])
    ) {
      const valueProps = inner.arguments[1];
      if (valueProps.getText(sf).includes(SOUND_FOCUS_LABELS.unfocused)) {
        bump(stats, 'fixed', 'notification-sound-select');
      } else if (valueProps.properties.length === 0) {
        const children = `(${valueText}) === "unfocused" ? ${JSON.stringify(SOUND_FOCUS_LABELS.unfocused)} : ${JSON.stringify(SOUND_FOCUS_LABELS.always)}`;
        edits.push({
          start: valueProps.getStart(sf),
          end: valueProps.end,
          replacement: `{ children: ${children} }`,
          key: 'notification-sound-select',
        });
        bump(stats, 'fixed', 'notification-sound-select');
      }
      return;
    }
    ts.forEachChild(inner, visit);
  };
  ts.forEachChild(props, visit);
}

function recordMissing(stats, key, file, classification) {
  if (!stats || !looksEnglish(key)) return;
  const entry = stats.missing.get(key) ?? {
    key,
    tier: classification.tier,
    rules: new Set(),
    files: new Set(),
    count: 0,
  };
  entry.count++;
  entry.rules.add(classification.rule);
  entry.files.add(path.basename(file));
  if (classification.tier === 'A') entry.tier = 'A';
  stats.missing.set(key, entry);
}

/**
 * Bir JavaScript paketini çevirir. `ctx.toastAliases` dosyadaki toast takma adlarını,
 * `ctx.logic` paketlerin herhangi bir yerinde karşılaştırma anahtarı olarak geçen metinleri taşır.
 */
function patchScript(source, file, dict, ctx = {}) {
  const stats = ctx.stats;
  source = applyTextPatches(source, stats);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error('JavaScript ayrıştırılamadı: ' + file);
  const toastAliases = new Set(ctx.toastAliases ?? []);
  if (!ctx.toastAliases) {
    // Tek dosyalık kullanımda (testler) takma adları bu dosyadan çıkar.
    for (const name of collectFacts(source, file).toastDefs) toastAliases.add(name);
  }
  const options = { toastAliases };
  const logic = ctx.logic ?? new Set();
  const renderer = isRendererFile(file);
  const cronBindings = new Set();
  const edits = [];

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && SHUTDOWN_IMPACT_NAME.test(node.name.text)) {
      const replacement = `function ${node.name.text}${SHUTDOWN_IMPACT_BODY}`;
      if (source.slice(node.getStart(tree), node.end) !== replacement) {
        edits.push({
          start: node.getStart(tree),
          end: node.end,
          replacement,
          key: 'shutdown-impact',
        });
      }
      bump(stats, 'fixed', 'shutdown-impact');
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toString' &&
      ts.isIdentifier(node.expression.expression) &&
      CRONSTRUE_NAME.test(node.expression.expression.text)
    ) {
      cronBindings.add(node.expression.expression.text);
      if (node.arguments.length === 1) {
        edits.push({
          start: node.end - 1,
          end: node.end - 1,
          replacement: ', {locale: "tr", use24HourTimeFormat: true}',
          key: 'cron-locale',
        });
        bump(stats, 'fixed', 'cron-locale-call');
      } else if (node.arguments[1]?.getText(tree).includes('locale: "tr"')) {
        bump(stats, 'fixed', 'cron-locale-call');
      }
    }
    if (ts.isCallExpression(node) && renderer) soundFocusSelectEdits(node, tree, edits, stats);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TEMPLATE_FN.test(node.expression.text) &&
      isStringLike(node.arguments[0])
    ) {
      const arg = node.arguments[0];
      const translated = patchHtml(arg.text, dict, stats);
      if (translated !== arg.text) {
        edits.push({
          start: arg.getStart(tree),
          end: arg.end,
          replacement: JSON.stringify(translated),
          key: 'chat-html',
        });
        bump(stats, 'rules', 'chat-html');
        return;
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const role = node.properties.find(
        (p) => ts.isPropertyAssignment(p) && propName(p.name) === 'role'
      );
      const hasLabel = node.properties.some(
        (p) => ts.isPropertyAssignment(p) && propName(p.name) === 'label'
      );
      if (
        role &&
        ts.isStringLiteral(role.initializer) &&
        NATIVE_MENU_LABELS[role.initializer.text]
      ) {
        if (!hasLabel) {
          edits.push({
            start: node.getStart(tree) + 1,
            end: node.getStart(tree) + 1,
            replacement:
              'label: ' + JSON.stringify(NATIVE_MENU_LABELS[role.initializer.text]) + ', ',
            key: 'native-menu',
          });
        }
        bump(stats, 'fixed', 'native-menu-labels');
      }
    }
    if (
      (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      source.slice(node.getStart(tree), node.end).includes('<!doctype html>')
    ) {
      const raw = source.slice(node.getStart(tree), node.end);
      const replacement = patchHtml(raw, dict, stats);
      if (replacement !== raw)
        edits.push({
          start: node.getStart(tree),
          end: node.end,
          replacement,
          key: 'recovery-html',
        });
      bump(stats, 'fixed', 'recovery-html');
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const key = keyOf(node);
      let classification = classifyLiteral(node, file, options, tree);
      if (
        (ts.isTemplateExpression(node) && UI_STATUS_KEYS.has(key)) ||
        (ts.isStringLiteral(node) &&
          UI_STATUS_KEYS.has(key) &&
          !ts.isPropertyAssignment(node.parent))
      ) {
        classification = { tier: 'A', rule: 'status' };
      }
      if (classification) {
        if (
          key === 'Continue' &&
          ts.isPropertyAssignment(node.parent) &&
          propName(node.parent.name) === 'name'
        )
          return;
        const translation = lookup(dict, key);
        const eligible = classification.tier === 'A' || (isSentenceLike(key) && !logic.has(key));
        if (translation && translation !== key && eligible) {
          edits.push({
            start: node.getStart(tree),
            end: node.end,
            replacement: translatedExpression(node, translation, source),
            key,
          });
          bump(stats, 'rules', classification.rule);
          return;
        }
        if (translation && !eligible && stats) stats.logicSkipped.add(key);
        if (!translation && (classification.tier === 'A' || isSentenceLike(key)))
          recordMissing(stats, key, file, classification);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);

  // İç içe düzenlemelerde dıştaki kazanır; ardından sondan başa uygulanır.
  const kept = [];
  for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = kept[kept.length - 1];
    if (previous && edit.start < previous.end) continue;
    kept.push(edit);
  }
  let result = source;
  for (const edit of kept.reverse()) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  result = injectCronLocale(result, cronBindings, stats);
  if (
    result !== source &&
    ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true).parseDiagnostics.length
  ) {
    throw new Error('Çeviri sonrası JavaScript geçersiz: ' + file);
  }
  return { result, edits };
}

/** cronstrue'nun Türkçe dil modülünü, paketteki cronstrue bağının hemen ardına ekler. */
function injectCronLocale(source, bindings, stats) {
  if (!bindings.size) return source;
  if (source.includes('ORKESTRA_CRON_TR')) {
    bump(stats, 'fixed', 'cron-locale-module');
    return source;
  }
  for (const name of bindings) {
    const escaped = name.replace(/\$/g, '\\$');
    const anchor = new RegExp(`(?:const|let|var) ${escaped} = [^\\n]+;`).exec(source);
    if (!anchor) continue;
    const locale = fs.readFileSync(localRequire.resolve('cronstrue/locales/tr'), 'utf8');
    bump(stats, 'fixed', 'cron-locale-module');
    const injected = `\n/* ORKESTRA_CRON_TR */\n(function(module, exports, require) {\n${locale}\n})({exports:{}}, {}, () => ${name});\n`;
    return (
      source.slice(0, anchor.index + anchor[0].length) +
      injected +
      source.slice(anchor.index + anchor[0].length)
    );
  }
  return source;
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeHtmlAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** HTML metin düğümlerini ve görünen öznitelikleri (title, aria-label…) çevirir. */
function patchHtml(source, dict, stats) {
  // Çalıştırılabilir blokları görünür HTML eşleştirmesinden önce koru.
  return source
    .split(/(<(?:script|style)\b[\s\S]*?<\\?\/(?:script|style)>)/gi)
    .map((part) => {
      if (/^<(?:script|style)\b/i.test(part)) return part;
      return part
        .replace(/<[a-zA-Z][^<>]*>/g, (tag) =>
          tag.replace(
            /(?<=[\s"'])([a-z][\w-]*)=("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
            (match, name, _raw, doubleQuoted, singleQuoted, bare) => {
              if (!UI_HTML_ATTRS.has(name)) return match;
              const value = decodeHtml(doubleQuoted ?? singleQuoted ?? bare);
              if (value.includes('${')) return match;
              const translation = lookup(dict, '@attr:' + value) ?? lookup(dict, value);
              if (!translation || translation === value) return match;
              bump(stats, 'rules', 'html-attribute');
              return `${name}="${encodeHtmlAttribute(translation)}"`;
            }
          )
        )
        .replace(/>[^<>]+</g, (chunk) => {
          const raw = chunk.slice(1, -1);
          const normalized = raw.trim().replace(/\s+/g, ' ');
          const translation = lookup(dict, normalized);
          if (!translation || translation === normalized) return chunk;
          bump(stats, 'rules', 'html-text');
          return '>' + raw.replace(raw.trim(), () => translation) + '<';
        });
    })
    .join('')
    .replace(/<html lang="en">/, '<html lang="tr">');
}

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );
}

/**
 * Yamalanacak dosyalar: adaptörler ve Monaco dil hizmeti işçileri hariç. İşçilerdeki `name`/
 * `description` tabloları tamamlama verisidir (ör. aria-relevant değerleri); çevrilmemelidir.
 */
function isPatchable(relative) {
  if (!/\.(?:js|mjs|cjs|html)$/.test(relative)) return false;
  if (relative.split(/[\\/]/).includes('adapters')) return false;
  return !/(?:^|[\\/])[\w.-]*\.worker-[\w-]+\.js$/.test(relative);
}

/** Komut satırı girişi; çıkış kodunu döndürür. */
function run(argv, env = process.env, log = console) {
  const [out, dictFile] = argv;
  if (!out || !dictFile || !fs.existsSync(out))
    throw new Error('Kullanım: node patch-tr.cjs out/ ui-tr.json');
  const dict = loadDictionary(dictFile);
  const files = walk(out).filter((f) => isPatchable(path.relative(out, f)));
  const scripts = files.filter((f) => !f.endsWith('.html'));

  const factsByFile = new Map();
  const logic = new Set();
  for (const file of scripts) {
    const facts = collectFacts(fs.readFileSync(file, 'utf8'), file);
    factsByFile.set(file, facts);
    for (const text of facts.logic) logic.add(text);
  }
  const toastAliases = resolveToastAliases(factsByFile);
  const stats = createStats();
  for (const [file, aliases] of toastAliases) {
    if (isRendererFile(path.relative(out, file)) && aliases.size)
      bump(stats, 'fixed', 'toast-alias', aliases.size);
  }

  const changed = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(out, file);
    const { result, edits } = file.endsWith('.html')
      ? { result: patchHtml(source, dict, stats), edits: [] }
      : patchScript(source, relative, dict, { toastAliases: toastAliases.get(file), logic, stats });
    if (result !== source) changed.push({ file, relative, result, count: edits.length });
  }

  const misses = Object.entries(REQUIRED_PATCHES).filter(([id]) => !stats.fixed[id]);
  const allowMisses = env[ALLOW_MISSES_ENV] === '1';
  for (const [id, description] of misses) {
    log.error(
      `[localize] ${allowMisses ? 'UYARI' : 'HATA'}: zorunlu yama eşleşmedi (${id}): ${description}`
    );
  }
  if (misses.length && !allowMisses) {
    log.error(
      `[localize] Hiçbir dosya yazılmadı. Yamaları güncelleyin ya da geçici olarak ${ALLOW_MISSES_ENV}=1 kullanın.`
    );
    return 1;
  }

  for (const entry of changed) fs.writeFileSync(entry.file, entry.result);
  if (env[MISSING_REPORT_ENV]) {
    const missing = [...stats.missing.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({ ...entry, rules: [...entry.rules], files: [...entry.files] }));
    fs.writeFileSync(env[MISSING_REPORT_ENV], JSON.stringify(missing, null, 1));
  }
  log.log(
    JSON.stringify(
      {
        changedFiles: changed.length,
        translatedOccurrences: changed.reduce((n, entry) => n + entry.count, 0),
        rules: stats.rules,
        fixedPatches: stats.fixed,
        missingRequiredPatches: misses.map(([id]) => id),
        skippedLogicKeys: stats.logicSkipped.size,
        missingTranslations: stats.missing.size,
        files: changed.map((entry) => ({ file: entry.relative, count: entry.count })),
      },
      null,
      2
    )
  );
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = {
  REQUIRED_PATCHES,
  classifyLiteral,
  collectFacts,
  createStats,
  isDisplayLiteral,
  isSentenceLike,
  keyOf,
  loadDictionary,
  patchHtml,
  patchScript,
  resolveToastAliases,
  run,
};
