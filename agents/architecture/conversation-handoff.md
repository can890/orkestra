# Sohbet çatallama ve devretme

Bir ACP sohbetini, aynı görevde yeni bir sohbete bağlamıyla taşır. Bu, CLI ↔ ACP görünüm
değişimi olan "runtime handoff" (`switch-conversation-view`) kavramından **bağımsızdır**.

## Eylemler

- Sekme menüsü "Sohbeti çatalla": aynı ajan, model ve (varsa) otomatik onay ayarıyla.
- Sekme menüsü "Başka ajana devret": ajan seçtiren pencere; yeni sohbet seçilen ajanla açılır ve
  otomatik onay **kapalı** başlar (yetki genişlemesin).
- Mesaj kutusundaki ajan seçici: sohbet başladıktan sonra kilitlenmez, "devir kipi"nde açılır
  ("Başka ajanla devam et", aşağıya bakın).
- Asistan mesajı altında "Buradan çatalla": özet o mesajı içeren turla (dahil) kesilir.
  `@orkestra/chat-ui` içinde `ChatCommands.onForkFromMessage` ile çalışır.

## Devir özeti

`src/core/features/conversations/api/handoff-summary.ts` içindeki `buildHandoffSummary` saf bir
fonksiyondur (G/Ç yok). Girdi: tur listesi (`TranscriptTurn` yapısal alt kümesi). Çıktı:
kullanıcı mesajları + her turun **son** ajan yanıtı + dokunulan dosyalar (create/modify/delete
araç çağrıları, iç içe gruplar dahil).

- Bütçe varsayılan 20.000 karakterdir; çıktı bütçeyi asla aşmaz (alt sınır 600).
- Seçim en yeni turdan geriye doğrudur; en yeni tur sığmazsa kırpılarak yine dahil edilir. Atlanan
  eski turlar için not düşülür. Metin kronolojik sırada yazılır.
- Tek mesaj üst sınırı: kullanıcı 2.500, ajan 3.500 karakter (baş + son korunur).
- Başlık, özetin talimat değil kayıt olduğunu belirtir. Geçmişte metin yoksa metin boştur ve
  çağıran hata verir.

## Akış (`browser/handoff/`)

1. `start-handoff.ts`: kaynak geçmişi `acp.loadHistory` ile sayfalar (en fazla 6 x 100 tur;
   okunamazsa ekrandaki turlar), özeti üretir, yeni ACP sohbetini `createConversation` ile açar,
   sekmeyi açar. **`initialQueue` kullanılmaz**: özet gönderilmez.
2. Özet `HandoffStore` içinde (renderer `localStorage`, DB şeması yok) yeni sohbet kimliğiyle
   saklanır. `AcpChatPanel` ilk istemde (sohbet boşken) bunu gizli bağlam olarak kullanıcının
   mesajına ekler. Gönderim reddedilirse sohbet boş kaldığından yeniden denemede yine eklenir.
3. Kaynak sohbete yazılmaz; yalnızca okunur.

## Soy bilgisi

`HandoffStore` kaydı (`mode`, `sourceConversationId`, `sourceTitle`, `sourceItemId`) sekmede
küçük bir rozetle gösterilir. Sohbet yapılandırma şemasına (`conversationConfig`) ve DB'ye
dokunulmaz; bu nedenle soy bilgisi yalnızca bu renderer profilinde kalır ve en fazla 200 kayıt
tutulur.

## Mesaj kutusundan "başka ajanla devam et"

`ChatComposer` (`packages/ui`) iki ajan kipi bilir: `agentLocked` tek başına eskisi gibi seçiciyi
kilitler; `agentLocked` + `agentSwitchMode="handoff"` seçiciyi açar. Açık seçicide şu anki ajan
"Şu anki ajan" başlığında seçili durur, diğerleri "Başka ajanla devam et" başlığı altında listelenir
(`buildHandoffAgentGroups`). Satırlar `ComposerAgentOption.badge` ile kısa bir kullanım rozeti
taşıyabilir ("limit doldu", "az kaldı"); rozet seçimi engellemez. Seçici, ana bileşende model
seçiciyle birlikte de gösterilir (devir kipinde ajan simgesi model düğmesinden seçiciye taşınır).
Paylaşılan UI paketi masaüstü özelliklerini bilmez: rozet verisini ve aday listesini ana uygulama
`acp-chat-panel.tsx` içinde prop olarak verir.

Akış:

1. Kullanıcı seçicide başka bir ajan seçer (ya da limit şeridindeki düğmeye tıklar). Bu yalnızca
   `openHandoffDialog(source, { targetProviderId })` çağırır: "Başka ajana devret" penceresi hedef
   ajan seçili, isteğe bağlı model seçimiyle açılır. Hiçbir şey kendiliğinden devredilmez.
2. Pencere özetin yeni ajana talimat değil kayıt olarak gideceğini, mevcut sohbetin yerinde
   kalacağını ve otomatik onayın kopyalanmadığını söyler. Kaynakta tur sürüyorsa pencere uyarır
   (engellemez, turu iptal etmez, kaynağa yazmaz); kullanıcı isterse önce "Durdur"a basar.
3. Onaylanınca `startConversationHandoff({ mode: 'handoff', providerId, model })` çalışır ve yeni
   sohbet sekmesi açılıp odağa gelir.

Adaylar "Başka ajana devret" penceresiyle aynı kaynaktan gelir (ajan listesi + kurulum durumu,
`use-handoff-agents.ts`): mevcut ajan hariç, ACP destekleyen ve kurulu olanlar. Süzme ve sıralama
`handoff-suggestions.ts` içindeki saf fonksiyonlardadır (`listHandoffCandidates`,
`sortHandoffCandidates`, `suggestHandoffAgents`).

### Kaldığı yerden devam et

Devirle açılan (`mode: 'handoff'`) boş sohbetin karşılama alanında (`HandoffNotice`) "Kaldığı yerden
devam et" düğmesi çıkar. Tıklanınca `CONTINUE_PROMPT` standart mesajı composer'ın olağan
`handleSubmit` yolundan gönderilir; devir özeti her zamanki gibi ilk istemde gizli bağlam olarak
eklenir (`composeHandoffHiddenContext`), görünür mesaja karışmaz. Düğme yalnızca kullanıcı
tıklayınca çalışır; sohbet hazır değilken devre dışıdır.

### Limit şeridi

Sohbetin ajanının kullanım kapasitesi `saturated` ise **ya da** son tamamlanan tur limit hatasıyla
bittiyse mesaj kutusunun üstünde kapatılabilir bir şerit çıkar: "<Ajan> kullanım limiti doldu"
(yenilenme zamanı biliniyorsa onunla) ve en fazla 3 "<Ajan> ile devam et" düğmesi + "Diğerleri…".

- Kapasite: `usage-limits` özelliğinin `contributions/browser/use-provider-capacities.ts` kancası
  (kenar çubuğu göstergesiyle aynı önbellek ve `evaluateUsageCapacity` kuralları). Sorgu yalnızca
  başlamış sohbette yapılır.
- Limit hatası sinyali: ACP çalışma zamanı limit hatalarını "kullanım limiti doldu" iletisine çevirir
  (`prompt-error-tr.ts`); `AcpChatStore.lastLimitErrorTurnId`, tamamlanmış son turun hata sonucu bu
  iletiye (ya da ham `usage limit`, `rate limit`, `quota`, `429` örüntülerine) uyuyorsa tur kimliğini
  tutar. Tur sürerken ya da yeni istem beklerken `null` olur. Hata iletisindeki "yenilenme süresi"
  hata anına göredir ve zaman damgası olmadığı için kullanılmaz; yenilenme zamanı yalnızca kullanım
  verisinden gelir.
- Öneri sırası: mevcut ajan hariç, ACP destekli ve kurulu adaylar; `ok`, sonra `tight`, sonra
  `unknown`. Kapasitesi `saturated` olanlar düğme olarak önerilmez; "Diğerleri…" penceresinde
  ("limit doldu" rozetiyle) seçilebilir kalır.
- **Otomatik geçiş yoktur**: şerit yalnızca önerir; tıklama onay penceresini açar.
- Kapatma: `decideLimitBanner` saf karardır. Her sinyalin kararlı bir anahtarı vardır
  (`saturated:<ajan>:<yenilenme zamanı, 10 dk'ya yuvarlı>` ya da `turn-error:<tur kimliği>`). Kapatılan
  anahtar yenilenme zamanına (bilinmiyorsa 5 saate) kadar tutulur (`LimitDismissalStore`, renderer
  `localStorage`, en fazla 200 sohbet, DB şeması yok). Pencere yenilenince doluluk sinyali kendiliğinden
  düşer; yeni bir doluluk yeni anahtar taşıdığı için şerit yeniden çıkabilir.

## Bağlam devri ("Sohbeti yeni bağlama taşı")

Bağlam penceresi dolarken işi, aynı görevde yeni bir sohbete **sapmadan** taşır: yeni sohbet aynı
ana makinede (yerel ya da SSH), aynı çalışma ağacında, aynı ajan, model, efor, izin ve iş birliği
kipiyle açılır, kaynağın yanındaki bölmede odaklanır ve ilk turu kendiliğinden başlar. Tıklama
onaydır; ikinci bir tıklama gerekmez.

Dosyalar:

- `api/context-handoff-policy.ts` (saf): eşik adımları, kapatma kuralları, şerit yığılma kuralı.
- `api/context-handoff-package.ts` (saf): devir notu isteği, notun çıkarılması, kullanıcı
  mesajlarının birebir seçimi, gizli bağlamın bütçeli birleştirilmesi, döküm konumu.
- `browser/handoff/context-handoff-service.ts`: akış (`ContextHandoffCoordinator`); G/Ç portlarla
  yapılır, sahtelerle test edilir (`context-handoff-service.test.ts`).
- `browser/handoff/context-handoff-runtime.ts`: portların uygulamaya bağlanması ve
  `moveConversationToNewContext(store)` giriş noktası.
- `browser/handoff/context-handoff-transcript.ts`: döküm dosyasının yazılması.
- `browser/handoff/context-handoff-banner.tsx`: mesaj kutusunun üstündeki şerit.

### Giriş noktaları

- Öneri şeridi (mesaj kutusunun üstünde). Varsayılan eşik %85 ("Bağlam dolmak üzere (%87).
  Konuyu yeni sohbete taşıyalım mı?"), %95'te daha güçlü ifade ("Bağlam neredeyse dolu (%96).
  Kalite düşmeden konuyu yeni sohbete taşıyalım mı?"). Düğmeler: "Yeni sohbete taşı" (ajan
  çalışıyorsa "Tur bitince taşı") ve "Şimdi değil". Uyarı üçgeni ve uyarı rengi yalnızca %95
  adımındadır.
- Sohbet sekmesi menüsü ve komut paleti: "Sohbeti yeni bağlama taşı"
  (`conversations.moveToNewContext`, oluşturucu kapsamı). Bağlam kullanımı bildirmeyen
  sağlayıcılarda şerit hiç çıkmaz; bu yollar her zaman çalışır.

Şeridin kuralları (`decideContextHandoffBanner`):

- Kullanım sayısı bilinmiyorsa, anlamsızsa (pencerenin 1,5 katından büyük) ya da güncel değilse
  (oturum kullanılamıyor, geçmiş yükleniyor) gösterilmez. Boş, taşınmış ya da taşıması süren
  sohbette gösterilmez.
- "Şimdi değil" sohbet ve adım başınadır: %85'te kapatılan şerit %95'te bir kez daha çıkar, %95'te
  kapatılan bir daha çıkmaz. Doluluk eşiğin 10 puan altına inince (ör. /compact) öneri kapatmaları
  sıfırlanır. Kayıtlar `ContextHandoffDismissalStore` (renderer `localStorage`) içindedir.

Şerit yığılma kuralı (`arrangeComposerBanners`): süren taşımanın durum şeridi her zaman gösterilir
ve öneriyle "taşındı" bildiriminin yerini alır; limit şeridi varken öneri ve "taşındı" bildirimi
gizlenir (limit şeridi zaten başka ajana geçmeyi önerir); /compact şeridi, özellik açıkken doluluk
eşiği geçtiğinde hiç çıkmaz (`contextHandoffOwnsContextWarning`). Devir ailesinden en fazla bir
şerit görünür. Şerit `@container` ile dar bölmelerde satır kırar ve ikincil metni gizler.

### Akış

1. Sıradaki mesajlar kaynağın kuyruğundan alınır (tur bitince orada başlamasınlar).
2. Kaynakta tur sürüyorsa tur bitene kadar beklenir; tur **iptal edilmez**. Şeritte "Tur bitince
   yeni sohbete taşınacak." ve "Vazgeç" görünür. Vazgeçilirse alınan mesajlar özgün hâlleriyle
   (gizli bağlam ve ekler dahil) kuyruğa geri konur.
3. Devir notu: kaynak ajana görünür bir kullanıcı mesajı gönderilir
   (`buildBriefRequestPrompt`, `[Bağlam devri]` ön ekiyle). Gönderim `AcpChatStore.sendVisiblePrompt`
   ile yapılır: taslağa dokunmaz, `auto` yerleşimiyle gider (boştaysa başlar, asla yönlendirmez ya da
   iptal etmez). İstek ve yanıt kaynak sohbette herkesin göreceği bir devir notu olarak kalır;
   kaynağa başka hiçbir şey yazılmaz, hiçbir şey silinmez.
4. Not, isteğin `promptId`'si (yoksa ön ek) ile bulunan turun ajan metinleridir. Tur hata, iptal
   ya da kesintiyle biterse, boşsa, 300 karakterden kısaysa, 5 dakikada bitmezse ya da oturum
   kullanılamıyorsa sezgisel özete (`buildHandoffSummary`) düşülür; neden hem gizli bağlamda hem de
   yeni sohbetin görünen ilk mesajında söylenir. Zaman aşımında kaynak tur iptal edilmez.
5. Döküm dosyası (aşağıya bakın) yazılır, paket birleştirilir, `HandoffRecord`
   (`mode: 'context-handoff'`, `contextSource`, `transcriptPath`, `context: ''`,
   `contextDelivered: true`) yazılır, taslak yeni sohbetin mesaj kutusuna aktarılır
   (`setPendingDraftText`; kaynağın taslağı yerinde kalır).
6. Yeni sohbet `createConversation` ile `initialQueue` kullanarak açılır: ilk öğe görünen devam
   mesajı + gizli devir paketi, ardından alınan sıradaki mesajlar (gizli bağlamsız). Proje belleği
   ana süreçte ilk öğenin gizli bağlamının önüne eklenir. Oturum hemen etkinleştirilir ve sekme
   kaynağın sağındaki bölmede (`paneLayout.open(..., { target: 'right' })`, önce kaynağın bölmesi
   etkin yapılır; Pano'da aynı görevin döşemesi içinde) açılıp odaklanır. Yeni sohbet boştur ve
   `workingTurnSubmitMode` devreye girmez.

İdempotentlik: `ContextHandoffCoordinator` kaynak başına tek iş tutar; süren işe ikinci tetikleme
aynı sözü döndürür. Kaynağın halefi varsa yeni sohbet açılmaz, halef açılır.

### Devir paketi (gizli bağlam)

Toplam en fazla 60.000 karakter (`CONTEXT_HANDOFF_BUDGET`), sırasıyla:

1. Başlık ve kurallar: bu sohbetin devam olduğu, aynı amaç/kısıt/kararlarla sürdürülmesi,
   kullanıcı mesajlarındaki talimatların geçerli olduğu, diğer bölümlerin kayıt olduğu.
2. "Devir notu (önceki ajanın kendi yazdığı)" ya da "Otomatik özet" (nedeniyle): en fazla 26.000.
3. "Kullanıcının mesajları (birebir, eskiden yeniye)": en fazla 22.000; en yeniden geriye seçilir,
   tek mesaj en fazla 6.000 (baş + son), atlanan ve kırpılan mesaj sayısı açıkça yazılır. Devir notu
   istekleri dahil edilmez.
4. "Açık durum": planın açık adımları, hâlâ çalışan alt ajanlar/arka plan görevleri, taşınan
   sıradaki mesajlar, aktarılan taslak (en fazla 6.000).
5. "Tam döküm": dosya yolu ve "belirsizse tahmin etme, önce bu dosyayı oku"; kaynak da bir bağlam
   devriyse onun dökümünün yolu.

Bütçe aşılırsa önce kullanıcı mesajları ve not kırpılır; başlık, döküm yolu ve kurallar korunur.

### Döküm dosyası

`formatTranscriptAsMarkdown` ile kaynak geçmişinin tamamı (en fazla 50 x 100 tur; okunamazsa
ekrandaki turlar) şu konuma yazılır: `<ana makinenin ev dizini>/.orkestra/handoffs/<yeni sohbet
kimliği>.md`. Ev dizini `projects.getHostHomeDir` ile, yazma dosya çalışma zamanıyla
(`files.fs.createDirectory` + `files.fs.upload`, `ResourceUri` ana makineyi taşır) yapılır; SSH
projelerinde dosya uzak makineye yazılır. Konum git çalışma ağacının dışındadır. Dosya 9 MB'ı
aşarsa en eski kısmı atılır ve başa not konur. Yazılamazsa taşıma yine yapılır; neden yeni ajana
söylenir. Dosyalar kendiliğinden silinmez.

### Soy bilgisi

Yeni sohbetin sekmesinde rozet ("… sohbetinden yeni bağlama taşındı") ve başlıkta "(devam)"
eki görünür. Kaynakta `HandoffStore.findContextSuccessor` ile bulunan halef için "Bu sohbet
şuraya taşındı: <başlık>" şeridi ve "Yeni sohbeti aç" düğmesi çıkar (kapatılabilir); taşınmış
sohbete öneri yapılmaz. Kayıtlar mevcut `HandoffStore` ile `localStorage` ve SQLite `kv`
tablosunda tutulur; şema alanları isteğe bağlıdır, DB göçü yoktur. Mobil uygulama yeni kipi
tanımaz ve kaydı atlar.

### Ayarlar

`chat.contextHandoffSuggestion` (varsayılan açık) ve `chat.contextHandoffThreshold` (50-95,
varsayılan 85), "Sohbet Davranışı" kartında. Kapalıyken yalnızca öneri şeridi kapanır.
