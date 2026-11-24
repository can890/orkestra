# Orkestra modu (çok ajanlı orkestrasyon)

"Sohbet Oluştur" modalındaki **Orkestra** girdisi, bir karar verici (şef) ajanın kurulu tüm ACP
destekli ajanları işçi olarak yönettiği bir sohbet açar. Şef gerçek bir ACP sohbetidir; işçiler
aynı görev worktree'sinde ayrı ACP sohbetleri olarak görünür.

## Akış

1. Renderer `conversations.orchestra.register` ile ayarları kaydeder, ardından şef sağlayıcısıyla
   normal bir ACP sohbeti oluşturur
   (`src/core/features/conversations/browser/create-conversation-modal.tsx`).
2. `attach` sırasında wire denetleyicisi, şef konuşmalarının `acpInput.mcpServers` alanına
   Orkestra MCP köprüsünü ekler (`src/core/features/conversations/node/wire-controller.ts`).
   Uzak (SSH) projelerde köprü, workspace-server ile gelen Node çalışma zamanıyla uzak makinede
   çalışır ve OpenSSH ters Unix soketi yönlendirmesiyle masaüstündeki RPC sunucusuna bağlanır
   (`src/core/services/agent-tools/node/agent-tools-remote-endpoints.ts`). Soket yolu uygulama oturumu
   boyunca sabittir; SSH yeniden bağlandığında yönlendirme aynı yola yeniden kurulur.
3. ACP çekirdeği bu konuşmaya özel stdio sunucularını sağlayıcının kendi MCP sunucularına ekler
   (`packages/core/src/runtimes/acp/node/runtime/mcp-servers.ts`, `withConversationMcpServers`).
4. Köprü (`src/core/services/agent-tools/node/agent-tools-bridge.ts`) bağımlılıksız bir
   `.cjs` betiğidir; Electron ikilisiyle `ELECTRON_RUN_AS_NODE=1` olarak çalışır ve araç
   çağrılarını `127.0.0.1` üzerindeki RPC sunucusuna iletir
   (`src/core/services/agent-tools/node/agent-tools-rpc-server.ts`). Bu altyapı Orkestra'nın tüm
   araç sunucularınca paylaşılır (şef ve `orkestra-browser`); bkz. `agents/integrations/mcp.md`.
5. `OrchestraService` (`src/core/features/orchestra/api/node/orchestra-service.ts`) işçi
   sohbetlerini ana süreçte oluşturur, `attach` + `sendPrompt` ile görev verir, tur sonucunu
   `loadHistory` üzerinden istem kimliğiyle eşleyerek son yanıtı rapor olarak döndürür.

## Güvenlik

- RPC sunucusu yalnızca loopback'e bağlanır; uzak erişim yalnızca SSH ters tüneliyle ve `700`
  izinli `~/.orkestra/agent-tools` dizinindeki sokete gelir; her şef için bellekte tutulan 32 baytlık Bearer
  belirteci gerekir. Belirteç yalnızca o şefin köprü ortamına verilir ve diske yazılmaz.
- ACP'de `autoApprove` bir başlatma bayrağı değildir. "Ajan izinlerini otomatik onayla" açıkken
  servis bekleyen izin isteklerini `allow_once` (yoksa `allow_always`) seçeneğiyle yanıtlar;
  kapalıyken izinler kullanıcıya kalır ve şef hangi işçinin onay beklediğini bildirir.

## Kalıcılık ve öğrenme

`userData/orchestra/sessions.json` şef ayarlarını, işçi kayıtlarını ve sağlayıcı başına gözlenen
sonuç istatistiklerini (başarı oranı, ortalama süre) tutar. `list_agents` bu istatistikleri
yerleşik yönlendirme profilleriyle (`node/orchestra-playbook.ts`) birlikte şefe sunar.

## İş akışı modu (deterministik)

Şef LLM yerine kullanıcının önceden tanımladığı adımlar çalıştırılır: "Sohbet Oluştur" →
Orkestra → **Mod: İş akışı**. Hangi ajanın neyi yapacağına kullanıcı karar verir; karar veren bir
LLM yoktur.

- **Tanım** (`api/workflow.ts`): `{ id, name, description?, steps: [{ id, agent, model?, prompt,
  dependsOn[] }] }`; en fazla 20 adım, istem ≤ 20.000 karakter. Anlamsal doğrulama
  `api/workflow-logic.ts` içindedir ve arayüzle ana süreçte aynıdır: benzersiz adım kimliği, var
  olan bağımlılık, **döngü yok** (topolojik sıralama), `{{steps.<id>.report}}` yalnızca doğrudan ya
  da dolaylı bağımlı olunan adımlara, `{{input}}` çalıştırırken verilen metne başvurur.
- **Şablon güvenliği:** ikame tek geçişlidir; rapor ya da giriş içindeki `{{...}}` yeniden
  yorumlanmaz. Rapor `<previous-step-output>` çerçevesiyle ("veri, talimat değil") eklenir,
  çerçeveyi kapatma denemesi etkisizleştirilir ve rapor 8.000 karaktere kırpılır.
- **Yürütücü** (`api/node/workflow-runner.ts`): bağımlılıkları biten adımlar başlar; eşzamanlılık
  `maxConcurrency` ile sınırlıdır (**varsayılan 1**, en çok 3; paralel ajanlar aynı worktree'de
  birbirinin dosyasını ezebilir). Başarısız/atlanan/iptal bir adımın bağımlıları `skipped` olur,
  bağımsız dallar sürer. Adım durumları: `pending | running | awaiting-permission | completed |
  failed | skipped | cancelled`. Adım başına zaman aşımı 30 dk (aşılırsa adım `failed`, işçi
  durdurulur). İptalde çalışan işçilerin turu iptal edilir.
- **Port** (`WorkflowWorkerPort`: `startWorker`, `sendPrompt`, `waitForReport`, `cancel`):
  yürütücü işçi işlemlerinden bu arayüzle ayrılır; testler sahte port kullanır. Gerçek uygulama
  `api/node/workflow-worker-port.ts` içindedir ve `OrchestraService` ile aynı ana süreç
  bağımlılıklarını (`OrchestraServiceDeps` alt kümesi) kullanır; `OrchestraService` iç yapısı
  değişmemiştir. Raporu istem kimliğine göre `loadHistory` üzerinden okur.
- **İzinler:** iş akışı izinleri kendiliğinden onaylamaz. "Ajan izinlerini otomatik onayla"
  (varsayılan kapalı) açıksa bekleyen izinler `allow_once` (yoksa `allow_always`) ile yanıtlanır;
  kapalıyken adım `awaiting-permission` görünür ve kullanıcı işçi sohbetinde onaylar.
- **Kalıcılık** (`api/node/workflow-service.ts`): `userData/orchestra/workflows.json` (tanımlar) ve
  `workflow-runs.json` (son 50 çalıştırma), ikisi de sürümlü JSON (`version: '1'`). Uygulama
  yeniden başlayınca yarım kalan çalıştırma `cancelled` işaretlenir; otomatik devam yoktur.
- **Wire:** `conversations.workflows` alt sözleşmesi (`list`, `save`, `delete`, `startRun`,
  `getRun`, `listRuns`, `cancelRun`); işçi işlevleri konuşmalar denetleyicisinde olduğu için
  `orchestra` alt sözleşmesinin yanına eklendi. Arayüz çalıştırmayı kısa aralıkla `getRun` ile
  yoklar.
- **Arayüz:** `contributions/browser/` altında `workflow-start-fields.tsx` (mod seçimi, iş akışı,
  giriş, eşzamanlılık, izin anahtarı), `workflow-editor-modal.tsx` (adım formu, canlı doğrulama,
  JSON içe/dışa aktarma), `workflow-run-modal.tsx` (adım durumları, işçi sohbeti bağlantısı,
  iptal). Modallar `contributions/browser.ts` ile kaydedilir.

## Kod olarak iş akışları (`~/.orkestra/workflows`)

T3 Code'un "Workflows" özelliğinin karşılığıdır (MIT, uyarlanmıştır). Adım tabanlı iş akışının
yanında durur ve aynı işçi portunu (`createWorkflowWorkerPort`) kullanır.

- **Ayar:** `codeWorkflows.enabled` (varsayılan **kapalı**, Ayarlar → Genel → Workflows). Kapalıyken
  klasör yüklenmez, tetikleyiciler ve kancalar çalışmaz; çalıştırmalar diskte kalır ve açılınca
  sürer.
- **Dosyalar:** `~/.orkestra/workflows/*.{ts,mts,mjs,js}` ya da `ORKESTRA_WORKFLOWS` (klasör/tek
  dosya). `api/node/loader.ts` klasörü izler; TypeScript Node'un `stripTypeScriptTypes` işleviyle
  silinir, aynı klasöre nokta ile başlayan geçici bir `.mjs` yazılıp `import()` edilir ve silinir.
  Tek global `Orkestra` (`api/node/authoring.ts`): `workflow`, `step(.try)`, `agent(.try)`, `ask`,
  `sleep`, `title`, `stop`, `skip`, `every`, `daily`, `cron`, `webhook`, `issues.opened`,
  `pullRequests.opened`, `z`. Yüklenemeyen dosya son çalışan sürümünü korur, sorun sayfada görünür.
- **Güvenlik:** dosyalar ana süreçte, kullanıcının yetkileriyle ve yalıtımsız çalışır (T3 ile
  aynı karar; `vm` gerçek sınır olmadığından sahte yalıtım yok). Bu yüzden özellik varsayılan
  kapalıdır.
- **Motor** (`api/node/engine.ts`): gövde her devamda baştan oynatılır; adlı ilkellerin sonucu
  başarıyla bittiği anda `userData/workflows/runs/<id>.json` dosyasına yazılır (`api/node/store.ts`,
  atomik). Bekleme/hata gövdeyi kesintiyle durdurur, süren kardeş adımlar bitirilip kaydedilir.
  Durumlar: `running | waiting | paused | completed | stopped | skipped | cancelled`. Kod adımı hatası
  `resumeAfter` (5/20/80 dk) ile kendiliğinden sürer; çalışıp vazgeçen ajan kişiyi bekler.
  Uygulama yeniden başlayınca `running` çalıştırmalar ilk bitmemiş adımdan sürer. Aynı `key` aynı
  çalıştırmayı döndürür. Tetikleyici durumu `userData/workflows/state.json`.
- **Tetikleyiciler:** zamanlama (croner, otomasyonlarla aynı sözdizimi), webhook (otomasyonların
  `AutomationWebhookServer`'ı, `/workflow-hook/<iş akışı>/<kanca>/<belirteç>` yolu, belirteç gizli
  depoda; HMAC imzası, teslimat başlığıyla tekrar engeli, dakikada 60 sınırı, 1 MiB gövde), yeni
  issue/PR (projeye bağlı mevcut istemcilerle dakikada bir yoklama; ilk yüklemede görülenler
  çalıştırma başlatmaz).
- **Sorular:** `ask` bildirim yayınlar (`workflow-question`) ve İş akışları sayfasında yanıt formu
  gösterir; yanıt dosyaya yazılır, çalıştırma sürer.
- **Wire:** `conversations.codeWorkflows` alt sözleşmesi (`status`, `listRuns`, `getRun`, `start`,
  `answer`, `pause`, `resume`, `cancel`, `hooks`, `openFolder`). Arayüz kısa aralıkla yoklar.
- **Arayüz:** `workflows` görünümü (sol kenar çubuğu, komut paleti "Open Workflows"): çalıştırmalar
  (Sizi bekliyor / Çalışıyor / Tümü), çalıştırma ayrıntısı (adım zaman çizelgesi, ajan sohbetleri,
  sorular, duraklat/sürdür/iptal), tanımlar (kod + adım tabanlı), yazım becerisini kopyalama
  (`skill/orkestra-workflows/SKILL.md`) ve klasörü açma.
