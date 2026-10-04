# Orkestra

<img src="apps/orkestra-desktop/src/assets/images/orkestra/orkestra.png" alt="Orkestra logosu" width="96" />

Türkçe arayüzle yerel bilgisayarda ve SSH sunucularında kodlama ajanlarını yöneten masaüstü uygulaması.

Claude, Codex, Kimi, GLM, Antigravity ve Grok; uygulama/servis bağlantı kataloğu; görsel ve dosya ekleri; gerçek veri sağlandığında hesap kullanım bilgileri bulunur. Sağlayıcının sunmadığı limit verisi tahmin edilmez. ElevenLabs ses üretimi için kullanılır; video işleme kodlama araçlarıyla yapılır.

## macOS kurulumu

[v1.2.7 indirme sayfası](https://github.com/can890/orkestra/releases/tag/v1.2.7): Apple Silicon için `orkestra-arm64.dmg`, Intel Mac için `orkestra-x64.dmg` seçin. DMG içindeki Orkestra uygulamasını Applications klasörüne sürükleyin. ZIP paketleri ve SHA-256 doğrulama dosyası aynı sayfadadır.

Paketler Apple Developer ID ile imzalanmamış ve noter onayından geçirilmemiştir. macOS ilk açılışı engellerse indirdiğiniz kaynağı doğrulayıp Sistem Ayarları → Gizlilik ve Güvenlik içinden uygulamaya özel açma izni verin. Otomatik güncelleme kapalıdır; yeni sürümleri GitHub'dan indirin.

## Kaynaktan çalıştırma

Node.js 24.14.0 ve pnpm 10.28.2 gereklidir.

```sh
pnpm install --frozen-lockfile
pnpm --filter @orkestra/orkestra-desktop dev
```

Geliştirme modunda bazı metinler kaynak dilinde olabilir. Paketlenen arayüzün Türkçe çevirisi depodaki araçla derleme sonrasında uygulanır:

```sh
pnpm --filter @orkestra/orkestra-desktop build
pnpm --filter @orkestra/orkestra-desktop package:mac
```

Linux için `package:linux`, Windows için `package:win` komutları kullanılır. İlgili sistemde paketleme ve imzalama ayarlarının ayrıca sağlanması gerekir. Bu sürümde macOS paketleri yayımlanır; Linux ve Windows için hazır paket sunulmaz.

## Hesaplar ve bağlantılar

Her kullanıcı kendi sağlayıcı hesabına giriş yapmalıdır. Hesap oturumları ve API anahtarları depoya dahil değildir. GitHub için `gh auth login` ile giriş yapıp Orkestra'dan CLI hesabını içe aktarabilirsiniz. Önceki projenin OAuth istemcisi ve hesap sunucusu kullanılmaz. Kendi GitHub OAuth uygulaması olan dağıtıcılar `ORKESTRA_GITHUB_CLIENT_ID` ile cihaz girişini etkinleştirebilir.

Google bağlantısı için kendi Google Cloud Desktop OAuth istemcinizi yapılandırın. Gerekli servis API'lerini etkinleştirin ve OAuth kaydındaki izinleri düzenleyin. Kaydınızı uygulamanın kullanıcı verisi dizininde `oauth/google-client.json` olarak saklayın. Paketleme sırasında `ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE` dosya yolu ile uygulama kaydı eklenebilir; `ORKESTRA_REQUIRE_GOOGLE_OAUTH=1` eksik kaydı derleme hatası yapar. Kullanıcı erişim/yenileme tokenları bu dosyaya konulamaz.

Orkestra'nın ortak Google uygulaması henüz herkese açık Google doğrulamasını tamamlamamıştır. Testing durumunda yalnızca izin verilen test hesapları bağlanabilir. GitHub'a yükleme bu kısıtı kaldırmaz; herkesin tek tıkla bağlanabildiği doğrulanmış bir Google yayını şu anda vaat edilmez.

Google ve diğer hizmetlerden alınan sonuçlar seçili yapay zekâ sağlayıcısına ve seçili SSH makinesine aktarılabilir. Yalnızca güvendiğiniz ajanları ve makineleri kullanın. İzinleri sağlayıcının hesap ayarlarından iptal edebilirsiniz.

## Uzak makineler

Uzak sunucu derleme/paketleme komutları `apps/workspace-server/docs/packaging.md` içindedir. Otomatik kurulum için kendi dağıtım sunucunuzdaki arşivleri ve kanal dosyalarını yayınlayıp Makine ayarlarındaki kurulum adresini belirtin (`ORKESTRA_WORKSPACE_SERVER_ARTIFACTS_URL` ortam değişkeni de desteklenir). Bu kaynak yayını hazır bir dağıtım sunucusu sağlamaz. Mevcut uyumlu sunucu kurulumları kullanılabilir.

## Doğrulama

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Tarayıcı, yerel modül, Electron ve SSH testleri uygun çalışma ortamını gerektirir. Yayın hazırlığında yapılan kontroller ve bilinen sınırlamalar `docs/publication-check.md` dosyasındadır.

## Lisans ve kaynak

Apache-2.0. Kaynak kod atıfları `NOTICE` ve `LICENSE.md` içindedir. Paketler, yapılandırma dosyaları, ortam değişkenleri ve protokol anahtarları Orkestra adını kullanır. Otomatik güncelleme ve geri bildirim gönderme devre dışıdır; dağıtım elle yönetilir.
