# Uzak erişim (mobil geçit) protokolü

Telefon uygulaması, masaüstündeki Orkestra'ya ağ üzerinden doğrudan bağlanır (aynı yerel ağ ya da
Tailscale). Sunucu/bulut yoktur; ajanlar ve sağlayıcı token'ları masaüstünde kalır. Bu belge
istemcinin **tek kaynağıdır**; istemci bu belgeye göre yazılır.

Kod yerleşimi:

- Taşıma ve şifreleme: `packages/wire/src/remote/` (`@orkestra/wire/remote` istemci + ortak,
  `@orkestra/wire/remote/node` sunucu).
- Masaüstü servisi, izin listesi, QR yükü: `apps/orkestra-desktop/src/core/features/remote-access/`.
- İzin listesinin tek kaynağı: `node/remote-surface.ts`. Bu belgedeki liste onunla eşleşmek
  zorundadır (`remote-surface.test.ts` denetler).

## 1. Genel bakış

1. Kullanıcı masaüstünde **Ayarlar → Mobil erişim** sayfasından özelliği açar (varsayılan
   **kapalı**; kapalıyken hiçbir port dinlenmez) ve "QR kodu oluştur" der.
2. Telefon QR'ı okur (§2), adreslerden birine WebSocket açar, el sıkışır (§4), sonra normal
   `@orkestra/wire` konuşmasını (call/attach/snapshot/...) şifreli çerçeveler içinde yürütür (§5).
3. Masaüstü yalnızca bir izin listesini sunar (§7). Listede olmayan her şey reddedilir.
4. Kullanıcı cihazı iptal edince açık bağlantı hemen kapanır ve sır silinir (§8).

İstemci TypeScript ise `@orkestra/wire/remote` içindeki `connectRemoteTransport` el sıkışmayı ve
şifrelemeyi eksiksiz yapar; §4-§6 başka dilde yazan ya da kütüphaneyi denetleyen içindir.

## 2. QR yük şeması

QR içeriği boşluksuz UTF-8 **JSON metnidir** (başka önek yok). Elle giriş için "Kodu kopyala"
düğmesi aynı metni panoya koyar. Şema (`api/pairing-payload.ts`, zod ile doğrulanır):

```json
{"k":"orkestra-pair","v":1,"h":"<masaüstü uuid>","n":"Ornek-Mac","a":["192.168.1.20","100.101.102.103"],"p":51234,"d":"<cihaz uuid>","s":"<43 karakter base64url>"}
```

| Alan | Anlam |
| --- | --- |
| `k` | Her zaman `"orkestra-pair"`. Başka değer: bu QR bizim değil, reddet. |
| `v` | Protokol sürümü, şimdilik `1`. Bilmediğin sürümde eşleşme yapma. |
| `h` | Masaüstü kimliği (`hostId`). Telefon bağlantıları buna göre saklar/ayırt eder. |
| `n` | Masaüstü adı (görüntüleme). |
| `a` | Aday IPv4 adresleri, en çok 6: önce LAN (10/8, 172.16/12, 192.168/16), sonra Tailscale (100.64.0.0/10). Sırayla dene. |
| `p` | WebSocket portu (1–65535). |
| `d` | Bu eşleştirmeye ayrılmış **cihaz kimliği** (`deviceId`, `^[A-Za-z0-9_-]{8,64}$`). El sıkışmada kullanılır. |
| `s` | 32 baytlık **eşleştirme sırrı**, base64url (dolgusuz, tam 43 karakter). Gizlidir. |

Kurallar:

- QR **10 dakika** geçerlidir ve yalnızca bir cihaz içindir; ilk başarılı el sıkışmada cihaz
  "eşleşmiş" olur ve sır kalıcı cihaz anahtarına dönüşür (süre sınırı kalkar). Süresi dolan ya da
  iptal edilen eşleştirmeyle bağlanmak `AUTH_FAILED` verir.
- Telefon `d`, `s`, `h` ve adresleri **güvenli depoda** (Android Keystore ile şifreli) saklar. `s`
  loglanmaz, hata mesajına konmaz, ekranda gösterilmez.
- Her bağlantıda sunucunun gönderdiği `welcome.addresses`/`welcome.port` (§4) ile kayıtlı adresler
  güncellenir (DHCP ile IP değişirse). Port değişirse yeniden eşleşmek gerekir.
- QR en çok 331 bayt (QR sürüm 14, düzey M) olacak şekilde üretilir.

## 3. Taşıma

- WebSocket, **düz `ws://`** (şifreleme uygulama katmanındadır): `ws://<adres>:<port>/orkestra-remote/v1`.
  IPv6 adres köşeli parantezle yazılır. Yol dışındaki istekler reddedilir.
- Android/Capacitor: WebView'ın `ws://` (cleartext) trafiğine izin vermesi gerekir
  (`android:usesCleartextTraffic="true"` ya da `network_security_config` ile özel ağ adresleri).
- Alt protokol/başlık gerekmez. WebSocket `binaryType = "arraybuffer"`.
- Bağlantı öncesi (el sıkışma) çerçeveleri **metin** (JSON), el sıkışma sonrası çerçeveler
  **ikili**dir. Sunucuda sıkıştırma (permessage-deflate) kapalıdır.
- Üst sınır: tek WebSocket mesajı 4 MiB (`REMOTE_MAX_FRAME_BYTES`). Aşan Wire yanıtı sunucuda
  `SERIALIZATION` hatasına çevrilir; geçmiş sayfalarını küçük tut (`limit` ≤ 50).
- Her cihaz için aynı anda **tek** ana oturum: yeni bağlantı eskisini `4409` ile kapatır. Buna ek
  olarak her cihaz, ana oturumu düşürmeden **yardımcı kanal** başına bir oturum açabilir (§4.5);
  aynı kanalın yeni oturumu yalnızca o kanalın eski oturumunu `4409` ile kapatır.
- Sunucu sınırları: en çok 8 eşzamanlı ana oturum (yardımcı kanal oturumları ayrıca kanal başına
  8), 32 bekleyen el sıkışma (adres başına 4).

## 4. El sıkışma ve anahtar türetme

Tüm baytlar **base64url** (RFC 4648 §5, dolgusuz) olarak JSON'da taşınır.

### 4.1 Adımlar

1. **İstemci → sunucu** (metin, ≤ 512 bayt):
   `{"t":"hello","v":1,"deviceId":"<d>","clientNonce":"<base64url 32 bayt>"}`
   `clientNonce` her bağlantıda yeni, kriptografik rastgele 32 bayttır.
2. **Sunucu → istemci** (metin): `{"t":"challenge","v":1,"serverNonce":"<base64url 32 bayt>"}`.
   Cihaz bilinmese de, iptal edilmiş de olsa sunucu **aynı şekilde** `challenge` döner (cihazın
   var olup olmadığı sızmaz); reddetme 3. adımdan sonra olur.
3. İki taraf anahtarları türetir (§4.2). İstemci kimlik doğrulama çerçevesini gönderir:
   **İstemci → sunucu** (ikili, şifreli, sayaç 0), düz metni UTF-8 JSON:
   `{"t":"auth","v":1,"deviceId":"<d>","clientName":"Pixel 9","platform":"android"}`
   (`clientName`, `platform` isteğe bağlı; ≤ 64 karakter, masaüstü listesinde görünür).
4. Sunucu çerçeveyi çözer. Çözülemezse/`deviceId` uyuşmazsa **`AUTH_FAILED`** (§6). Başarıda
   **Sunucu → istemci** (ikili, şifreli, sayaç 0):
   `{"t":"welcome","v":1,"hostId":"…","hostName":"…","addresses":["192.168.1.20"],"port":51234}`
5. **İstemci `welcome` çerçevesini çözüp doğrulamadan hiçbir Wire mesajı göndermez.** Bu, sunucunun
   sırrı bildiğini kanıtlar (sahte sunucu yanıt üretemez). Doğrulanamazsa bağlantıyı kapat ve
   hata olarak `AUTH_FAILED` ele al.

"Her tarafın ilk şifreli çerçevesi anahtar sahipliğini kanıtlar": istemcinin `auth`'u istemciyi,
sunucunun `welcome`'ı sunucuyu doğrular. Sunucu, `auth` doğrulanmadan önce hiçbir şifreli çerçeve
göndermez ve hiçbir Wire mesajı işlemez.

### 4.1.1 Yardımcı kanal (`channel`)

`auth` çerçevesi isteğe bağlı `"channel":"<ad>"` taşıyabilir (`^[a-z][a-z0-9-]{0,31}$`). Şimdilik tek
kanal vardır: **`notifications`** — telefonun arka plan bildirim servisi (§4.5). Kanal isteyen
istemciyi sunucu `welcome` içinde aynı `"channel"` alanını yansıtarak kabul eder; sunmadığı kanal
için `PROTOCOL` (`4400`) ile reddeder. Kanalı tanımayan **eski sunucu** alanı yok sayar ve
`welcome`'da yansıtmaz: istemci bunu görünce bağlantıyı **hemen kapatmalıdır** (aksi halde ana
oturumun yerine geçmiş olur). Bozuk kanal adı `AUTH_FAILED` sayılır.

### 4.2 Anahtar türetme (standart HKDF-SHA256)

```
secret       = base64url_decode(QR.s)                   // 32 bayt
salt         = clientNonce ‖ serverNonce                // 64 bayt (bayt birleştirme)
key_c2s      = HKDF-SHA256(ikm=secret, salt=salt, info=UTF8("orkestra-remote/v1 c2s"), L=32)
key_s2c      = HKDF-SHA256(ikm=secret, salt=salt, info=UTF8("orkestra-remote/v1 s2c"), L=32)
```

İstemci `key_c2s` ile **şifreler**, `key_s2c` ile **çözer**; sunucu tersini yapar. WebCrypto:
`importKey("raw", secret, "HKDF", false, ["deriveKey"])` ardından
`deriveKey({name:"HKDF",hash:"SHA-256",salt,info}, base, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"])`.
Anahtarlar çıkarılamaz (`extractable:false`) türetilir; sır ve anahtarlar asla loglanmaz.

### 4.3 Çerçeve biçimi (el sıkışma sonrası her ikili WebSocket mesajı)

```
frame      = counter(8 bayt, big-endian, işaretsiz) ‖ ciphertext ‖ tag(16 bayt)
nonce(12)  = direction(4 bayt, big-endian) ‖ counter(8 bayt, big-endian)
direction  = 0x00000001 (istemci→sunucu)   0x00000002 (sunucu→istemci)
AEAD       = AES-256-GCM, AAD = counter'ın 8 baytı, tag 128 bit
```

- Sayaç her yönde **0'dan** başlar, her çerçevede **tam 1** artar (el sıkışmanın `auth`/`welcome`
  çerçeveleri 0'dır; ilk Wire/ping çerçevesi 1).
- Alıcı, beklenen sayaçtan farklı bir çerçeveyi (**tekrar, atlanmış, sırasız**) ya da etiketi
  doğrulanmayan çerçeveyi reddeder ve bağlantıyı `4401` ile kapatır. Aynı nonce ile iki kez
  şifreleme yapılmaz (sayaç yeniden kullanılmaz; yeni bağlantıda yeni nonce'lar → yeni anahtarlar).
- Aralık: sayaç 2^53−1'i geçemez (pratikte sınırsız).
- Bir bağlantıda kayıttan oynatma yeni bağlantıda işe yaramaz: anahtarlar `serverNonce`'a bağlıdır.

### 4.4 Şifreli çerçevenin düz metni (el sıkışma sonrası, sayaç ≥ 1)

UTF-8 JSON, üç tür:

- `{"t":"wire","m":<WireMessage>}` — Wire mesajı (§5).
- `{"t":"ping"}` — istemci her **25 sn**'de gönderir; sunucu `{"t":"pong"}` döner.
- `{"t":"pong"}`.

70 sn boyunca karşıdan hiçbir çerçeve gelmezse bağlantı ölü sayılıp kapatılır (iki yan da).
Çözülemeyen/tanınmayan düz metin bağlantıyı `4400` ile kapatır.

### 4.5 Arka plan bildirim kanalı (`notifications`)

Telefonun yerel (Java) ön plan servisi, ana uygulama kapalıyken de eşleşmiş her bilgisayara bu
kanaldan bağlanır. Kanal oturumu yalnızca ajan etkinliği akışını görür (`remote-surface.ts`
`REMOTE_NOTIFICATIONS_*`): `agentActivity.getSnapshot` ve `agentActivity.events`; başka her yol
`UNKNOWN_PROCEDURE`/`UNKNOWN_TOPIC`. Aynı eşleştirme sırrıyla açıldığı için ek bir yetki sınırı
değildir; amaç sürekli açık bağlantının yüzeyini küçültmektir. Cihaz iptali (§8) ana ve kanal
oturumlarının hepsini `4403` ile kapatır. Masaüstü cihaz listesi kanal bağlantısını ayrıca gösterir
(`notificationsConnected`).

Akış: istemci önce `attach` (`agentActivity.events`), sonra `call` (`agentActivity.getSnapshot`)
gönderir; snapshot'taki `revision`'dan eski olayları yok sayar. Olaylar `update.delta.event`
içindedir: `upsert` (`entry` + `alert`), `remove`, `publishing` (masaüstü ayarı değişti → snapshot
yeniden çekilir). Kayıt alanları: `conversationId`, `projectId`, `taskId`, `state`
(`working` | `needs-approval` | `asked-question` | `finished` | `failed`), `title`, `projectName`,
`providerName`, `preview` (≤ 240 karakter, tek satır), `stateChangedAt`, `startedAt`, `revision`.
Snapshot en çok 40 kayıt ve 64 KiB'tır; biten/başarısız sonuçlar host'ta 30 dk tutulur. Sohbet
içeriği, dosya yolu ya da komut çıktısı taşınmaz. Masaüstü ayarı **Ayarlar → Mobil erişim →
"Publish agent activity to paired devices"** (varsayılan açık) kapatılınca snapshot boş döner ve
olay gönderilmez (yalnızca tek bir `publishing:false` olayı).

## 5. Wire konuşması

`wire` zarfı içindeki `m`, `@orkestra/wire`'ın `WireMessage` türüdür (JSON). Tür tanımı:
`packages/wire/src/api/protocol.ts`. İstemci için en kolay yol `@orkestra/wire/rpc` kullanmaktır:

```ts
import { connect, client, reconnectingTransport } from '@orkestra/wire/rpc';
import { connectRemoteTransport, base64UrlDecode, RemoteHandshakeError } from '@orkestra/wire/remote';

const secret = base64UrlDecode(payload.s)!; // Uint8Array(32)
const transport = reconnectingTransport(async () => {
  for (const address of payload.a) {
    try {
      return await connectRemoteTransport({
        address, port: payload.p, deviceId: payload.d, secret,
        clientName: 'Pixel 9', platform: 'android',
      });
    } catch (error) {
      if (error instanceof RemoteHandshakeError && !error.retryable) throw error;
    }
  }
  throw new Error('Masaüstüne ulaşılamadı');
}, { shouldRetry: (error) => !(error instanceof RemoteHandshakeError && !error.retryable) });
await transport.ready();
const connection = connect(transport);
```

`connect(transport)` döndürdüğü bağlantıyla `domainClient` benzeri istemciler kurulur; masaüstü
sözleşmeleri `apps/orkestra-desktop/src/core/features/*/api/` altındadır (yol adları §7).

Wire yolları `alan.uç.nokta` biçimindedir (ör. `conversations.acp.sendPrompt`); canlı konular
`konuKimliği` ya da `konuKimliği|<anahtar JSON>` (ör.
`conversations.acp.session.state|{"conversationId":"…"}`).

Uzak oturumda **yoktur**: ikili (blob) kanallar ve dosya yükleme/indirme. `blob-*` mesajları ve
`call.upload` taşıyan çağrılar bağlantıyı `4400` ile kapatır.

Reddedilen çağrı: `result` mesajı `ok:false`, `code:"UNKNOWN_PROCEDURE"` (yordam) ya da
`UNKNOWN_TOPIC` (canlı konu) ile döner; girdi izin kuralına uymuyorsa `CONTRACT_MISMATCH`.

## 6. Hata kodları

Şifre çözülmeden önce sunucu tek bir metin çerçevesi gönderebilir, ardından bağlantıyı kapatır:

`{"t":"error","code":"<KOD>","message":"…","retryAfterMs":30000}`

| Kod | WebSocket kapanış kodu | Anlam | İstemci davranışı |
| --- | --- | --- | --- |
| `AUTH_FAILED` | 4401 | Yanlış sır, bilinmeyen/iptal/süresi dolmuş cihaz, bozuk/tekrar edilmiş çerçeve | **Yeniden deneme yok.** Kullanıcıya "yeniden eşleştir" göster |
| `RATE_LIMITED` | 4429 | Başarısız denemeler çok fazla (adres ya da cihaz başına) | `retryAfterMs` sonra dene |
| `VERSION_UNSUPPORTED` | 4426 | `hello.v` desteklenmiyor | Uygulamayı/masaüstünü güncelle |
| `PROTOCOL` | 4400 | Bozuk hello/zarf, yasak mesaj | Hata; yeniden deneme anlamsız |
| `BUSY` | 4503 | Bekleyen el sıkışma/oturum sınırı | Kısa beklemeyle yeniden dene |

Yalnızca kapanış kodu olarak görülenler: `4403` (cihaz **iptal edildi**; sır silindi → eşleşmeyi
sil), `4408` (el sıkışma 10 sn'de bitmedi), `4409` (aynı cihazın yeni oturumu eskisini değiştirdi),
`4413` (çerçeve çok büyük), `1001` (masaüstü özelliği kapattı / boşta zaman aşımı).

Hız sınırı: 60 sn içinde 5 başarısız el sıkışma → adres (ve ayrıca cihaz kimliği) 30 sn kilitlenir;
her tekrarda iki katına çıkar (üst sınır 15 dk). Başarılı el sıkışma sayacı sıfırlar. El sıkışma
10 sn içinde tamamlanmalıdır.

## 7. İzinli yüzey (`remote-surface.ts`)

**Varsayılan reddet.** Aşağıdaki liste tamdır; yeni uç noktalar kendiliğinden eklenmez. Hiçbir
koşulda açılmaz: secret'lar/token'lar, SSH kimlik bilgileri, hesap/sağlayıcı oturum açma, terminal
ve PTY, dosya okuma/yazma, ayar değiştirme, proje/görev oluşturma-silme, MCP, entegrasyonlar,
`remoteAccess` (eşleştirme) alanı.

### 7.1 İzinli yordamlar (`call`)

| Yol | Not |
| --- | --- |
| `projects.resolveRepositoryDestination` | `{host:{type:"local"}, name}`; yeni yerel proje klasörü yolu |
| `projects.createProject` | `{type:"local", name, path, initGitRepository?}`; yeni yerel proje başlatır |
| `projects.ensureFreeChatProject` | Projesiz serbest sohbetler için dahili çalışma alanını hazırlar |
| `tasks.createTask` | `{id(uuid), projectId, taskConfig(ACP), workspaceConfig}`; yeni görev ve ilk ACP sohbetini başlatır |
| `conversations.getConversations` | Tüm sohbetler |
| `conversations.getConversationsForTask` | `{projectId, taskId}` |
| `conversations.getConversationsForProject` | `{projectId}` |
| `conversations.createConversation` | `{id(uuid), projectId, taskId, provider, title, type:"acp", initialPrompt?}`; yeni ACP sohbeti başlatır |
| `conversations.markConversationSeen` | `{conversationId}` |
| `conversations.readMediaPreview` | `{conversationId, uri, offset?, maxBytes?}`; hassas yollar hariç parçalı salt-okunur okuma. Dosya boyutu sınırı yok (`offset` serbest); çağrı başına `maxBytes` ≤ 8 MiB (base64 ile 16 MiB çerçeveye sığar). Yanıttaki `maxChunkBytes` yeni sunucuyu belirtir; yoksa eski sunucu (80 MB dosya / 40 MB konum sınırı). Uzak (SSH) çalışma alanındaki sohbetlerde dosya Mac'te değil sohbetin hostunda okunur (files runtime `offset` → SFTP → sıralı akış; yalnızca istenen aralık); host telefondan değil sohbetten gelir, aynı hassas yol listesi gerçek (symlink çözülmüş) yola da uygulanır; eksik dosya `Dosya bulunamadı (<SSH bağlantı adı>).` |
| `conversations.acp.attach` | `{conversationId}`; oturumu (gerekirse) başlatıp bağlar |
| `conversations.acp.loadHistory` | `{conversationId, before?, limit}`; `1 ≤ limit ≤ 200` |
| `conversations.acp.sendPrompt` | `{conversationId, promptId(uuid), prompt:{text}, placement?:"auto"\|"queue"\|"steer"}`; `text` 1–100000 karakter; **`hiddenContext` ve `attachments` yok** |
| `conversations.acp.cancelTurn` | `{conversationId}` |
| `conversations.acp.deleteQueuedPrompt` | `{conversationId, id}`; henüz gönderilmemiş sıradaki mesajı kaldırır (telefon "Sil"/"Düzenle") |
| `conversations.acp.changeQueuePromptOrder` | `{conversationId, ids[≤200]}`; sırayı değiştirir (telefon "Şimdi gönder": öne al, sonra `cancelTurn`) |
| `conversations.acp.setOption` | `{conversationId, key:"model"\|"mode"\|"effort"\|"collaborationMode", value}`; oturum model/mod/efor seçeneğini değiştirir |
| `conversations.acp.cancelSubagent` | `{conversationId, runId(uuid)}`; çalışan alt ajanı durdurur |
| `conversations.acp.resolvePermission` | `{conversationId, requestId, optionId}` |
| `conversations.handoff.listAll` | Devir/çatal kayıtları ve geçersiz kılınmış sohbet eşlemeleri |
| `conversations.handoff.put` | `{conversationId, record}`; devir/çatal soy kaydı yazar (gizli/yol alanı yok) |
| `conversations.handoff.markSuperseded` | `{oldConversationId, newConversationId}`; önceki sohbeti devredilmiş işaretler |
| `agents.listMetadata` | Ajan/sağlayıcı listesi (ad, ikon vb.) |
| `agents.accountUsage` | `{host, providerId}` salt okunur kullanım |
| `usageLimits.get` | `{host, providerIds[], force?}` kullanım limitleri |
| `sourceControl.checkout.getChangedFiles` | `{workspaceId, target}` çalışma ağacı / stage değişen dosyalar (salt okunur) |
| `sourceControl.checkout.getFileHunks` | `{workspaceId, path, scope}` tekil dosya hunk diff parçaları (salt okunur) |
| `notifications.feed.markRead` | Bildirim durumu |
| `notifications.feed.markAllRead` | Bildirim durumu |
| `notifications.feed.dismiss` | Bildirim durumu |
| `agentActivity.getSnapshot` | Ajan etkinliği snapshot'ı (yalnızca uzak yüzeyde; §4.5). Arka plan `notifications` kanalında da açık |

`host` değeri `{"type":"local","id":"local"}` biçimindedir (yerel masaüstü).

### 7.2 İzinli canlı konular (`snapshot`/`attach`)

| Konu | Anahtar | İçerik |
| --- | --- | --- |
| `projects.projectList.list` | yok | Projeler |
| `tasks.taskList.list` | `{projectId}` | Görevler |
| `tasks.taskStats.stats` | `{projectId}` | Görev istatistikleri |
| `conversations.events` | yok | Sohbet yaşam döngüsü olayları (event stream) |
| `conversations.acp.sessions.list` | `{host, projectId}` | Oturum özetleri |
| `conversations.acp.session.state` | `{conversationId}` | Oturum durumu ve transkript |
| `conversations.acp.session.config` | `{conversationId}` | Oturum seçenekleri (salt okunur) |
| `conversations.acp.session.usage` | `{conversationId}` | Kullanım |
| `conversations.acp.session.plan` | `{conversationId}` | Plan |
| `conversations.acp.session.agents` | `{conversationId}` | Alt ajanlar |
| `conversations.acp.session.activeTurn` | `{conversationId}` | Süren tur (bekleyen izin istekleri burada) |
| `agents.auth.list` | `{host}` | Bağlı sağlayıcı hesapları ve oturum durumu (token yok) |
| `notifications.feed.list` | yok | Bildirim akışı |
| `notifications.delivery` | yok | Bildirim teslim olayları |
| `agentActivity.events` | yok | Ajan etkinliği olayları (yalnızca uzak yüzeyde; §4.5). Arka plan `notifications` kanalında da açık |

Bilerek **yok**: `conversations.acp.session.terminals`, `…mcpServers`, `…terminalOutput`
(komut/çıktı ve MCP yapılandırması taşıyabilir).

### 7.3 Tipik akışlar

- Ana ekran: `projects.projectList.list` → proje seç → `tasks.taskList.list|{"projectId":…}` →
  görev seç → `conversations.getConversationsForTask`.
- Sohbeti aç: `conversations.acp.attach`, `conversations.acp.loadHistory` (eskiye doğru
  `before` imleciyle), canlı için `conversations.acp.session.state|{"conversationId":…}` ve
  `…activeTurn`.
- Prompt gönder: `conversations.acp.sendPrompt` (tur sürerken `placement:"auto"` kuyruğa alır; telefon çalışan tura `placement:"steer"` ile canlı yönlendirme gönderir, yönlendiremeyen ajanlarda sunucu turu iptal edip yeni mesajı önce çalıştırır).
- İzin isteği: `activeTurn`/`state` içindeki bekleyen istek `requestId` ve `options[].optionId`
  taşır → `conversations.acp.resolvePermission`.
- Hesaplar: `agents.auth.list|{"host":{"type":"local","id":"local"}}` + `usageLimits.get`.

## 8. Cihaz yönetimi ve iptal

- Masaüstü **Ayarlar → Mobil erişim**: aç/kapat, QR üret, eşleşmiş cihaz listesi, tek tek iptal.
- İptal sırası: önce sır silinir (yeniden bağlanamaz), sonra o cihazın açık oturumu hemen
  `4403` ile kapatılır. Özelliği kapatmak dinleyiciyi kapatır, tüm oturumları `1001` ile bitirir
  ve bekleyen eşleştirmeleri siler; eşleşmiş cihazlar kalır.
- En çok 10 cihaz; aynı anda en çok 3 bekleyen QR.
- Port ilk açılışta rastgele seçilip saklanır (49152–65000); çakışırsa yenisi seçilir. Sunucu her
  bağlantıda güncel adreslerini `welcome` içinde bildirir.

## 9. Güvenlik özeti ve tehdit modeli

- **Kimin neyi yapabildiği:** Eşleşmiş bir telefon, §7'deki yüzeyi kullanabilir; yani sohbetleri
  okuyabilir ve ajanlara prompt/izin yanıtı gönderebilir. **Ajanlar bu bilgisayarda komut
  çalıştırabildiği için, eşleşmiş bir cihaz fiilen "ajana komut verebilen" yetkisi taşır.** Cihazı
  kaybeden kullanıcı onu masaüstünden hemen iptal etmelidir.
- **Korunan:** ağ dinleyicisi (pasif/aktif; içerik şifreli ve kimliği doğrulanmış, AES-256-GCM),
  tekrar/sırasız/kurcalanmış çerçeve, yanlış sır, sır tahmini (hız sınırı), kimlik doğrulamasız Wire
  erişimi (el sıkışmadan önce hiçbir Wire mesajı işlenmez), izin listesi dışı uç noktalar,
  iptal edilen cihazın açık bağlantısı.
- **Korunmayan:** (1) QR/eşleştirme kodunu ele geçiren saldırgan (10 dk içinde eşleşebilir);
  (2) telefonun ya da masaüstünün ele geçirilmesi; (3) trafik analizi (boyut/zaman, adresler);
  (4) servis reddi (pre-auth bağlantı sınırları var ama engellemez); (5) ileri gizlilik yok: sır
  sızarsa kaydedilmiş geçmiş trafik çözülebilir (anahtarlar sırdan ve nonce'lardan türer);
  (6) `0.0.0.0` dinleme: açıkken tüm arayüzlerden bağlantı kabul edilir (kimlik doğrulaması şart,
  yine de güvenmediğin ağlarda özelliği kapat); (7) paylaşılan ağda başkası mesajları okuyamaz ama
  `ws://` olduğu için port taraması bağlantı noktasını görür.

## 10. GitHub hesabıyla eşleşme (QR'sız)

Ayar: **Ayarlar → Mobil erişim → "GitHub hesabıyla eşleş"** (varsayılan kapalı; yalnızca mobil erişim
açıkken açılabilir). Kod: `node/account-pairing-coordinator.ts`; ortak çekirdek
`packages/wire/src/remote/account-pairing*.ts` (belge biçimi, ECDH anahtarları, gist deposu).

- **Akış:** masaüstü kalıcı bir ECDH(P-256) anahtar çifti üretir ve kendi kaydını (ad, adresler, port,
  açık anahtar) varsayılan GitHub hesabının gizli bir gist'ine yazar. Aynı hesapla giriş yapan telefon
  belgeye bir `request` (kendi açık anahtarı + `deviceId`) yazar. Masaüstü belgeyi 30 sn'de bir okur;
  geçerli isteği `registerDerivedDevice` ile **bekleyen eşleşme** olarak kaydeder (QR'daki gibi 10 dk,
  aynı sınırlar, aynı sır anahtarı) ve isteği belgeden siler. Telefon sırrı kendi ucunda türetir ve
  §4'teki el sıkışmayla bağlanır; sonrası QR eşleşmesiyle aynıdır.
- **Güven modeli:** belgeye yalnızca hesap sahibi yazabilir; belgede görünen istek aynı hesaptan gelmiştir.
  Belge gizli değil, listelenmemiştir: adresini bilen okuyabilir. Eşleştirme sırrı hiçbir zaman belgeye
  ya da ağa yazılmaz; iki uç ECDH → HKDF ile ayrı ayrı türetir. Hesabın belirteci ele geçirilirse
  saldırgan eşleşme isteği yazabilir (QR'ın ele geçirilmesiyle aynı sınıf risk, §9).
- **Belgeye yazılanlar:** masaüstü kimliği, ad, yerel ağ/Tailscale adresleri, port, açık anahtar,
  güncellenme zamanı; telefon isteği: `deviceId`, ad, platform, açık anahtar, zaman. Özel anahtar
  `SecretStore`'da (`remoteAccess.accountPairing.hostKey`) kalır; kalıcı durumda yalnızca
  `accountPairing: { enabled, gistId, publicKey }` bulunur (eski kayıtlarda yoktur, geriye uyumlu).
- **Yayın:** ayar açılınca, port/adres değişince ve 24 saatten eskiyse kayıt yazılır; belge zaten
  güncelse yeniden yazılmaz. Yoklama ETag'li koşullu istektir (değişmediyse yanıt 304).
- **Kapatma:** ayar ya da mobil erişim kapanınca yoklama durur ve kayıt belgeden silinir (belge yoksa
  oluşturulmaz). Ayar kapanırken ayrıca özel anahtar silinir, `publicKey`/`gistId` temizlenir.
- **Durumlar** (`getAccountPairingState`): `off`, `waiting-remote-access`, `no-account` (bağlı GitHub
  hesabı yok), `missing-scope` (belirtecin `gist` izni yok), `unauthorized` (belirteç geçersiz), `error`
  (ağ/hız sınırı; 30 sn'den başlayıp en çok 5 dk'ya çift katlanarak yeniden dener), `active`.
  `missing-scope` ve `unauthorized` durumunda yoklama durur; ayarı değiştirmek ya da "Şimdi kontrol et"
  yeniden başlatır.
- **Uzak yüzey:** bu özellik `remote-surface.ts` izin listesine **hiçbir şey eklemez**. Ayar yordamları
  (`getAccountPairingState`, `setAccountPairingEnabled`, `checkAccountPairingNow`) yalnızca yerel
  renderer'a açık `remoteAccess` domain'indedir; yeni dinleyici açılmaz.
