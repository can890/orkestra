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
