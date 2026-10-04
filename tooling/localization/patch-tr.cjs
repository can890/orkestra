#!/usr/bin/env node
// Orkestra'nın derlenmiş arayüzündeki sabit metinleri kod yapısını koruyarak çevirir.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.resolve(__dirname, '../../apps/orkestra-desktop/package.json'));
let ts;
ts = localRequire('typescript');
const UI_STATUS_KEYS = new Set(["You're up to date", "Update ready to install", "An update is available", "Current ${0} version v${1} is up to date", "Version v${0} is available. Update and restart ${1} to use the new version", "Version v${0} is available. Download and restart ${1} to use the new version", "Restart ${0} to use the new version", "${0} lines added", "${0} lines removed", "Update request failed with HTTP ${0}"]);
const UI_PROPS = new Set(['children', 'title', 'label', 'placeholder', 'searchPlaceholder', 'description', 'aria-label', 'ariaLabel', 'aria-description', 'tooltip', 'emptyMessage', 'detail', 'buttonLabel', 'confirmLabel', 'cancelLabel', 'loadingText', 'emptyText', 'errorMessage', 'helperText', 'alt', 'heading', 'subtitle', 'text', 'name', 'buttons', 'defaultLabel']);
const CHAT_LABELS = new Set(['Thinking', 'Thinking ${0}s', 'Thought briefly', 'Thought for ${0}s', 'Thought', 'Working...', 'Working…']);
function isDisplayLiteral(node, file) {
  let child = node;
  for (let i = 0; i < 12 && child.parent; i++, child = child.parent) {
    const parent = child.parent;
    if (ts.isConditionalExpression(parent) && parent.condition === child) return false;
    if (ts.isBinaryExpression(parent) && ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) return false;
    if (ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isTemplateSpan(parent)) return false;
    if (ts.isPropertyAssignment(parent)) {
      if (parent.name === child) return false;
      const key = parent.name.text;
      if (key === 'message') return /renderer/.test(file);
      return UI_PROPS.has(key);
    }
    if (ts.isCallExpression(parent)) {
      const fn = parent.expression.getText();
      return /^(toast\w*(\.(error|success|info|warning))?|alert|confirm)$/.test(fn) || /(?:setError|setValidationError|setErrorMessage|setStatusMessage)$/.test(fn);
    }
    if (ts.isNewExpression(parent)) return false;
    if (ts.isVariableDeclaration(parent) && /renderer/.test(file) && CHAT_LABELS.has(keyOf(node))) return true;
    if (ts.isVariableDeclaration(parent)) return /(?:label|title|description|tooltip|placeholder|heading|hint|Text)$/i.test(parent.name.getText());
    if (ts.isReturnStatement(parent)) {
      let fn = parent.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      return !!fn?.name && /(?:label|title|description|message|tooltip|placeholder|heading|hint|Text)/i.test(fn.name.getText());
    }
    if (ts.isFunctionLike(parent)) return /renderer/.test(file) && CHAT_LABELS.has(keyOf(node));
  }
  return false;
}
function keyOf(node) {
  return ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span, index) => '${' + index + '}' + span.literal.text).join('') : node.text;
}
function translatedExpression(node, translation, source) {
  if (!ts.isTemplateExpression(node)) return JSON.stringify(translation);
  const spans = [...translation.matchAll(/\$\{(\d+)\}/g)].map(m => Number(m[1]));
  if (spans.length !== node.templateSpans.length || new Set(spans).size !== node.templateSpans.length || spans.some(i => i >= node.templateSpans.length)) throw new Error('Çeviri yer tutucuları eşleşmiyor: ' + keyOf(node));
  const pieces = [];
  let end = 0;
  for (const match of translation.matchAll(/\$\{(\d+)\}/g)) {
    pieces.push(JSON.stringify(translation.slice(end, match.index)));
    const expr = node.templateSpans[Number(match[1])].expression;
    pieces.push('__orkestra' + Number(match[1]));
    end = match.index + match[0].length;
  }
  pieces.push(JSON.stringify(translation.slice(end)));
  const args=node.templateSpans.map(span=>'String('+source.slice(span.expression.getStart(),span.expression.end)+')');
  return '((' + args.map((_,i)=>'__orkestra'+i).join(',') + ') => (' + pieces.join(' + ') + '))(' + args.join(',') + ')';
}
function patchScript(source, file, dict) {
  source = source.replace('`${isExpanded ? "Collapse" : "Expand"} ${projectLabel}`', '`${projectLabel} — ${isExpanded ? "Daralt" : "Genişlet"}`');
  source = source.replace('children: /* @__PURE__ */ jsxRuntimeExports.jsx(Go$1.Value, {}) }),\n                      /* @__PURE__ */ jsxRuntimeExports.jsxs(Go$1.Content, { className: "min-w-max", children: [\n                        /* @__PURE__ */ jsxRuntimeExports.jsx(Go$1.Item, { value: "always"', 'children: /* @__PURE__ */ jsxRuntimeExports.jsx(Go$1.Value, {children: notifications2?.soundFocusMode === "unfocused" ? "Yalnızca odakta değilken" : "Her zaman"}) }),\n                      /* @__PURE__ */ jsxRuntimeExports.jsxs(Go$1.Content, { className: "min-w-max", children: [\n                        /* @__PURE__ */ jsxRuntimeExports.jsx(Go$1.Item, { value: "always"');
  source = source.replace(/(const AGENTS_SECTION_INSTALLED = )"Installed"/, '$1"Kurulu"').replace(/(const AGENTS_SECTION_RECOMMENDED = )"Recommended"/, '$1"Önerilen"').replace(/(const AGENTS_SECTION_NOT_INSTALLED = )"Not installed"/, '$1"Kurulu değil"').replace(/(id: "continue",\s*name: )"Devam et"/, '$1"Continue"');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error('JavaScript ayrıştırılamadı: ' + file);
  const edits = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'describeShutdownImpact') {
      const replacement = `function describeShutdownImpact(summary) {
        const localAgents = summary.acpSessions + summary.localTuiSessions;
        const impacts = [];
        if (localAgents > 0) impacts.push(localAgents + ' çalışan ajan oturumu');
        if (summary.terminals > 0) impacts.push(summary.terminals + ' terminal');
        const prefix = summary.incomplete ? 'En az ' : '';
        const stopped = impacts.length ? prefix + impacts.join(' ve ') + ' durdurulabilir.' : summary.incomplete ? 'Çalışan ajan oturumları ve terminaller durdurulabilir.' : 'Arka plan hizmetleri ve otomasyonlar duracak.';
        const remote = summary.remoteSessions > 0 ? ' ' + prefix + summary.remoteSessions + ' uzak oturum çalışmaya devam edecek.' : '';
        return stopped + remote;
      }`;
      if (source.slice(node.getStart(tree), node.end) !== replacement) edits.push({start:node.getStart(tree),end:node.end,replacement,key:'shutdown-impact'});
      return;
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'cronstrue.toString' && node.arguments.length === 1) {
      edits.push({start:node.end-1,end:node.end-1,replacement:', {locale: "tr", use24HourTimeFormat: true}',key:'cron-locale'});
    }
    if (ts.isCallExpression(node) && /^(?:template|template\$\d+)$/.test(node.expression.getText(tree)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const arg = node.arguments[0], original=arg.text, translated=patchHtml(original,dict);
      if (translated !== original) { edits.push({start:arg.getStart(tree),end:arg.end,replacement:JSON.stringify(translated),key:'chat-html'}); return; }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const role=node.properties.find(p=>ts.isPropertyAssignment(p) && p.name.text==='role');
      const labels={services:'Hizmetler',hide:'Gizle',hideOthers:'Diğerlerini gizle',unhide:'Tümünü göster',cut:'Kes',copy:'Kopyala',paste:'Yapıştır',pasteAndMatchStyle:'Biçimi eşleştirerek yapıştır',delete:'Sil',selectAll:'Tümünü seç',reload:'Yeniden yükle',forceReload:'Zorla yeniden yükle',toggleDevTools:'Geliştirici araçları',resetZoom:'Gerçek boyut',zoomIn:'Yakınlaştır',zoomOut:'Uzaklaştır',togglefullscreen:'Tam ekran',windowMenu:'Pencere',minimize:'Simge durumuna küçült',zoom:'Büyüt',front:'Tümünü öne getir'};
      if(role && ts.isStringLiteral(role.initializer) && labels[role.initializer.text] && !node.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.text==='label')) edits.push({start:node.getStart(tree)+1,end:node.getStart(tree)+1,replacement:'label: '+JSON.stringify(labels[role.initializer.text])+', ',key:'native-menu'});
    }
    if ((ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) && source.slice(node.getStart(tree),node.end).includes('<!doctype html>')) {
      const raw=source.slice(node.getStart(tree),node.end), replacement=patchHtml(raw,dict);
      if(replacement!==raw) edits.push({start:node.getStart(tree),end:node.end,replacement,key:'recovery-html'});
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && (isDisplayLiteral(node, file) || (ts.isTemplateExpression(node) && UI_STATUS_KEYS.has(keyOf(node))) || (ts.isStringLiteral(node) && UI_STATUS_KEYS.has(node.text) && !ts.isPropertyAssignment(node.parent)))) {
      const key = keyOf(node);
      if (key === 'Continue' && ts.isPropertyAssignment(node.parent) && node.parent.name.text === 'name') return;
      const branded = key.replace(/\bOrkestra\b/g, 'Orkestra');
      const translation = dict[key] ?? dict[branded] ?? (branded !== key ? branded : undefined);
      if (translation && translation !== key) {
        edits.push({ start: node.getStart(tree), end: node.end, replacement: translatedExpression(node, translation, source), key });
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  let result = source;
  for (const edit of edits.sort((a,b) => b.start-a.start)) result = result.slice(0,edit.start) + edit.replacement + result.slice(edit.end);
  if (ts.createSourceFile(file,result,ts.ScriptTarget.Latest,true).parseDiagnostics.length) throw new Error('Çeviri sonrası JavaScript geçersiz: '+file);
  return { result, edits };
}
function patchHtml(source, dict) {
  // Preserve executable blocks before matching visible HTML text.
  return source.split(/(<(?:script|style)\b[\s\S]*?<\\?\/(?:script|style)>)/gi).map(part => {
    if (/^<(?:script|style)\b/i.test(part)) return part;
    return part.replace(/>[^<>]+</g, chunk => {
      const raw=chunk.slice(1,-1), normalized=raw.trim().replace(/\s+/g,' '), branded=normalized.replace(/\bOrkestra\b/g,'Orkestra');
      const value=dict[normalized] ?? dict[branded] ?? branded;
      return '>'+raw.replace(raw.trim(),value)+'<';
    });
  }).join('').replace(/<html lang="en">/, '<html lang="tr">');
}
function walk(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]); }
if (require.main === module) {
  const [out, dictFile] = process.argv.slice(2);
  if (!out || !dictFile || !fs.existsSync(out)) throw new Error('Kullanım: node patch-tr.js out/ ui-tr.json');
  const dict=JSON.parse(fs.readFileSync(dictFile,'utf8')); const report=[];
  for (const file of walk(out).filter(f=>/\.(?:js|mjs|cjs|html)$/.test(f) && !f.includes('/adapters/'))) {
    const source=fs.readFileSync(file,'utf8');
    let {result,edits}=file.endsWith('.html')?{result:patchHtml(source,dict),edits:[]}:patchScript(source,file,dict);
    if (result.includes('cronstrue.toString') && !result.includes('ORKESTRA_CRON_TR')) {
      const anchor = /const cronstrue = [^\n]+;/.exec(result);
      if (!anchor) throw new Error('Zamanlama çevirisi için cronstrue bulunamadı');
      const locale = fs.readFileSync(localRequire.resolve('cronstrue/locales/tr'), 'utf8');
      result = result.replace(anchor[0], anchor[0] + '\n/* ORKESTRA_CRON_TR */\n(function(module, exports, require) {\n' + locale + '\n})({exports:{}}, {}, () => cronstrue);\n');
    }
    if(result!==source){fs.writeFileSync(file,result);report.push({file:path.relative(out,file),count:edits.length});}
  }
  console.log(JSON.stringify({changedFiles:report.length,translatedOccurrences:report.reduce((n,x)=>n+x.count,0),files:report},null,2));
}
module.exports={patchScript,patchHtml,isDisplayLiteral,keyOf};
