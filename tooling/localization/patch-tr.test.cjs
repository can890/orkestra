// patch-tr.cjs için birim testleri: node --test tooling/localization/patch-tr.test.cjs
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const patcher = require('./patch-tr.cjs');

const DICT = {
  Copied: 'Kopyalandı',
  'Could not archive task': 'Görev arşivlenemedi',
  'Checking for updates...': 'Güncellemeler denetleniyor...',
  'Checked for updates': 'Güncellemeler denetlendi',
  'Failed to send message': 'Mesaj gönderilemedi',
  'Workspace was not found.': 'Çalışma alanı bulunamadı.',
  'Merge pull request': "Pull request'i merge et",
  'Select one item': 'Tek bir öğe seçin',
  'Stop generating': 'Yanıtı durdur',
  'awaiting permission': 'izin bekleniyor',
  'Awaiting permission': 'İzin bekleniyor',
  Always: 'Her zaman',
  'Only when unfocused': 'Yalnızca odakta değilken',
  'Could not open ${0}: ${1}': '${0} açılamadı: ${1}',
};

const TOAST_DEFINITION = `const Rt$3 = Object.assign((a2, t2) => toast(a2, t2), {
  success: (a2, t2) => toast.success(a2, t2),
  error: (a2, t2) => toast.error(a2, t2),
  promise: (a2, t2) => toast.promise(a2, t2),
  dismiss: (a2) => toast.dismiss(a2)
});
`;

function patch(source, file = 'renderer/assets/index.js', ctx = {}) {
  return patcher.patchScript(source, file, DICT, { stats: patcher.createStats(), ...ctx }).result;
}

test('renamed toast aliases are detected from their Object.assign definition', () => {
  const result = patch(
    `${TOAST_DEFINITION}Rt$3.error("Could not archive task");\nRt$3("Copied");\nnotAToast.error("Copied");\n`
  );
  assert.match(result, /Rt\$3\.error\("Görev arşivlenemedi"\)/);
  assert.match(result, /Rt\$3\("Kopyalandı"\)/);
  // Tek sözcüklü metinler yalnızca kesin arayüz konumlarında çevrilir.
  assert.match(result, /notAToast\.error\("Copied"\)/);
});

test('toast aliases are followed across chunk imports', () => {
  const dir = path.join(os.tmpdir(), 'orkestra-l10n-alias');
  const index = path.join(dir, 'index-abc.js');
  const chunk = path.join(dir, 'chunk-def.js');
  const facts = new Map([
    [index, patcher.collectFacts(`${TOAST_DEFINITION}export { Rt$3 as R };\n`, index)],
    [
      chunk,
      patcher.collectFacts(
        'import { R as notify } from "./index-abc.js";\nnotify("Copied");\n',
        chunk
      ),
    ],
  ]);
  const aliases = patcher.resolveToastAliases(facts);
  assert.deepEqual([...aliases.get(chunk)], ['notify']);
  const result = patch(
    'import { R as notify } from "./index-abc.js";\nnotify("Copied");\n',
    'renderer/assets/chunk-def.js',
    {
      toastAliases: aliases.get(chunk),
    }
  );
  assert.match(result, /notify\("Kopyalandı"\)/);
});

test('_toastError, toast.promise options and disabled reasons are display positions', () => {
  const result = patch(`${TOAST_DEFINITION}class Store {
  send() { this._toastError("Failed to send message", new Error("x")); }
}
Rt$3.promise(work(), { loading: "Checking for updates...", success: "Checked for updates", error: "Copied" });
const availability = disabled$1("Select one item");
`);
  assert.match(result, /this\._toastError\("Mesaj gönderilemedi"/);
  assert.match(result, /loading: "Güncellemeler denetleniyor\.\.\."/);
  assert.match(result, /success: "Güncellemeler denetlendi"/);
  assert.match(result, /error: "Kopyalandı"/);
  assert.match(result, /disabled\$1\("Tek bir öğe seçin"\)/);
});

test('sentence detection accepts short words between longer ones', () => {
  assert.equal(patcher.isSentenceLike('Select a Project.'), true);
  assert.equal(patcher.isSentenceLike('Could not open ${0}: ${1}'), true);
  assert.equal(patcher.isSentenceLike('Copied'), false);
  assert.equal(patcher.isSentenceLike('Title: ${0}'), false);
  assert.equal(patcher.isSentenceLike('a b'), false);
  assert.equal(patcher.isSentenceLike('/usr/local/bin node'), false);
});

test('label maps are translated by their variable name', () => {
  const result = patch(
    'const mergeLabels = { merge: "Merge pull request" };\nconst ids = { merge: "Merge pull request" };\n',
    'main/x.js'
  );
  assert.match(result, /mergeLabels = \{ merge: "Pull request'i merge et" \}/);
  assert.match(result, /ids = \{ merge: "Merge pull request" \}/);
  const lookalike = patch('const objCopy = { merge: "Merge pull request" };\n', 'main/x.js');
  assert.match(lookalike, /objCopy = \{ merge: "Merge pull request" \}/);
});

test('main-process errors are translated unless the text is used as a comparison key', () => {
  const thrown = 'function f() { throw new Error("Workspace was not found."); }\n';
  assert.match(patch(thrown, 'main/chunks/a.js'), /new Error\("Çalışma alanı bulunamadı\."\)/);
  const compared = `${thrown}const missing = (e) => e.message === "Workspace was not found.";\n`;
  const facts = patcher.collectFacts(compared, 'main/chunks/a.js');
  const result = patch(compared, 'main/chunks/a.js', { logic: facts.logic });
  assert.match(result, /new Error\("Workspace was not found\."\)/);
  assert.match(result, /=== "Workspace was not found\."/);
});

test('template literals keep their placeholders', () => {
  const result = patch(
    'Rt$3.error(`Could not open ${path2}: ${result.error}`);\n',
    'renderer/assets/index.js',
    {
      toastAliases: new Set(['Rt$3']),
    }
  );
  const shown = [];
  vm.runInNewContext(result, {
    Rt$3: { error: (message) => shown.push(message) },
    path2: 'a.txt',
    result: { error: 'EACCES' },
  });
  assert.deepEqual(shown, ['a.txt açılamadı: EACCES']);
});

test('prototype property names are never treated as dictionary keys', () => {
  const result = patch(
    'function d(k) { switch (k) { case 177: return "constructor"; } }\nconst x = { name: "toString" };\n',
    'renderer/assets/index.js'
  );
  assert.match(result, /return "constructor"/);
  assert.match(result, /name: "toString"/);
});

test('Solid template attributes and text are translated', () => {
  const result = patch(
    'const a = template(\'<button type=button aria-label="Stop generating">\');\nconst b = template(\'<span title="Awaiting permission"aria-label="awaiting permission">\');\n'
  );
  assert.match(result, /aria-label=\\"Yanıtı durdur\\"/);
  assert.match(result, /title=\\"İzin bekleniyor\\"aria-label=\\"izin bekleniyor\\"/);
});

test('fixed patches match renamed identifiers', () => {
  const stats = patcher.createStats();
  const source = `const label = \`\${isExpanded2 ? "Collapse" : "Expand"} \${projectLabel$1}\`;
jsxRuntimeExports.jsxs(Zz$9.Root, { value: settings?.soundFocusMode ?? "always", children: [
  jsxRuntimeExports.jsx(Zz$9.Trigger, { children: jsxRuntimeExports.jsx(Zz$9.Value, {}) }),
  jsxRuntimeExports.jsxs(Zz$9.Content, { children: [
    jsxRuntimeExports.jsx(Zz$9.Item, { value: "always", children: "Always" }),
    jsxRuntimeExports.jsx(Zz$9.Item, { value: "unfocused", children: "Only when unfocused" })
  ] })
] });
const AGENTS_SECTION_INSTALLED$1 = "Installed";
`;
  const { result } = patcher.patchScript(source, 'renderer/assets/index.js', DICT, { stats });
  assert.match(result, /`\$\{projectLabel\$1\} — \$\{isExpanded2 \? "Daralt" : "Genişlet"\}`/);
  assert.match(
    result,
    /Zz\$9\.Value, \{ children: \(settings\?\.soundFocusMode \?\? "always"\) === "unfocused" \? "Yalnızca odakta değilken" : "Her zaman" \}/
  );
  assert.match(result, /AGENTS_SECTION_INSTALLED\$1 = "Kurulu"/);
  assert.equal(stats.fixed['project-expand-label'], 1);
  assert.equal(stats.fixed['notification-sound-select'], 1);
  assert.equal(stats.fixed['agents-section-installed'], 1);
  // Yama ikinci kez çalıştığında da (idempotent) eşleşmiş sayılır.
  const again = patcher.createStats();
  assert.equal(
    patcher.patchScript(result, 'renderer/assets/index.js', DICT, { stats: again }).result,
    result
  );
  assert.equal(again.fixed['notification-sound-select'], 1);
  assert.equal(again.fixed['project-expand-label'], 1);
});

test('dictionary entries with mismatched placeholders are rejected', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orkestra-l10n-')), 'dict.json');
  fs.writeFileSync(file, JSON.stringify({ 'Open ${0}': 'Aç' }));
  assert.throws(() => patcher.loadDictionary(file), /yer tutucular/);
});

function fixtureOut() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestra-l10n-'));
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(out, 'renderer', 'assets'), { recursive: true });
  const file = path.join(out, 'renderer', 'assets', 'index.js');
  fs.writeFileSync(file, 'const toast2 = (m) => m;\ntoast2("Copied");\n');
  const dictFile = path.join(root, 'ui-tr.json');
  fs.writeFileSync(dictFile, JSON.stringify(DICT));
  return { out, file, dictFile };
}

const silent = { log() {}, error() {} };

test('run() fails without writing when a required patch matches nothing', () => {
  const { out, file, dictFile } = fixtureOut();
  const before = fs.readFileSync(file, 'utf8');
  const errors = [];
  const code = patcher.run([out, dictFile], {}, { log() {}, error: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(errors.some((line) => line.includes('notification-sound-select')));
  assert.ok(errors.some((line) => line.includes('toast-alias')));
});

test('ORKESTRA_L10N_ALLOW_MISSES=1 downgrades required-patch misses to warnings', () => {
  const { out, file, dictFile } = fixtureOut();
  const code = patcher.run([out, dictFile], { ORKESTRA_L10N_ALLOW_MISSES: '1' }, silent);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /toast2\("Kopyalandı"\)/);
});

test('the CLI exits non-zero on required-patch misses', () => {
  const { out, dictFile } = fixtureOut();
  const env = { ...process.env };
  delete env.ORKESTRA_L10N_ALLOW_MISSES;
  const child = spawnSync(process.execPath, [path.join(__dirname, 'patch-tr.cjs'), out, dictFile], {
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /zorunlu yama eşleşmedi/);
});
