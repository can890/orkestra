# Sohbet çatallama ve devretme

Bir ACP sohbetini, aynı görevde yeni bir sohbete bağlamıyla taşır. Bu, CLI ↔ ACP görünüm
değişimi olan "runtime handoff" (`switch-conversation-view`) kavramından **bağımsızdır**.

## Eylemler

- Sekme menüsü "Sohbeti çatalla": aynı ajan, model ve (varsa) otomatik onay ayarıyla.
- Sekme menüsü "Başka ajana devret": ajan seçtiren pencere; yeni sohbet seçilen ajanla açılır ve
  otomatik onay **kapalı** başlar (yetki genişlemesin).
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
