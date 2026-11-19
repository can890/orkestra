# Artifact paylaşımı

Sohbette üretilen bir artifact iki yolla paylaşılabilir (artifact satırındaki "Paylaş"):

- **Tek dosya HTML dışa aktarma**: sunucudan bağımsızdır; HTML artifact olduğu gibi, görsel gömülü
  bir sayfa olarak `saveTextFile` ile kaydedilir (`browser/artifact-share-payload.ts`).
- **Yerel ağ bağlantısı**: ana süreçte `node/artifact-share-server.ts` içindeki
  `ArtifactShareServer` artifact'in bellek anlık görüntüsünü `http://<lan-ip>:<port>/a/<belirteç>`
  adresinde salt okunur sunar. Wire alanı: `artifactShares` (`create`, `list`, `revoke`).

## Güvenlik sözleşmesi

- **Varsayılan kapalı**: hiç etkin paylaşım yokken port dinlenmez. Sunucu ilk paylaşımda
  başlar; son paylaşım iptal edilince ve uygulama kapanırken (wire controller `scope`) durur.
- **Belirteç**: `randomBytes(16)` base64url (128 bit), `timingSafeEqual` ile karşılaştırılır.
  Belirteçsiz/yanlış belirteçli her istek gövdesiz 404 alır; dizin listeleme yoktur.
- **Yalnızca anlık görüntü**: sunucu dosya sistemine hiç dokunmaz. İstek yolu yalnızca bellekteki
  `Map` anahtarlarıyla tam eşleşir; `..`, `\`, NUL, boş parça ve `/` ile başlayan adlar reddedilir.
- Paylaşım başına 20 MB, aynı anda en fazla 10 etkin paylaşım.
- Yalnızca `GET`/`HEAD` (diğerleri 405). Başlıklar: `Content-Security-Policy: sandbox
  allow-scripts; default-src 'self' data: blob: 'unsafe-inline'`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
  `Cross-Origin-Resource-Policy: same-origin`. Çerez ve CORS yok.
- Bağlantı şifresiz http'dir ve yalnızca aynı ağdaki cihazlardan açılabilir; arayüz bunu açıkça
  söyler.

Şu an arayüz yalnızca artifact'in kendi dosyasını paylaşır; sunucu birden çok dosyayı
(`files`) destekler ama bağlı/göreli kaynakları toplama henüz yapılmaz.
