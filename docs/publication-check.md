# Yayın kontrolü — 4 Ekim 2026

Bu yayın, özelleştirilmiş Orkestra kaynaklarının temiz bir kopyasıdır. Eski Git geçmişi, kişisel oturumlar, OAuth dağıtım kayıtları, yerel sunucu adresleri ve `.orig` yedekleri dahil edilmemiştir. Test veritabanları yalnızca değişmemiş upstream fixture dosyalarından alınmıştır.

## Başarılı kontroller

- `pnpm install --frozen-lockfile --ignore-scripts` ile temiz bağımlılık kurulumu.
- Yedi ortak paketin Nx derlemesi.
- Masaüstü üretim derlemesi ve depodaki Türkçe çeviri işlemi.
- Masaüstü `tsconfig.node.json` ve `tsconfig.browser.json` tip kontrolleri.
- Bağlantılar, Google giriş, ek dosyalar, katalog ve uzak kurulum: 45 test.
- Görsel aktarımı, Türkçe hata, Grok faturalama, OAuth ve kullanım verisi: 31 test.
- Grok ACP ve ajan kaydı: 9 test.
- Antigravity ACP: 13 test.
- Google OAuth dağıtım kaydının doğrulanması: 3 test.
- Eski hesap sunucusuna istek/oturum aktarımının engellenmesi ve hesap işlemleri: 26 test.
- Yayın hazırlığında değiştirilen sunucu/kimlik modülleri için hedefli lint.
- Kaynak metinlerde kimlik bilgisi, özel anahtar, sağlayıcı tokenı ve kişisel yol/adres taraması. Eşleşmeler sahte test verileri ve katalog yer tutucularıyla sınırlıdır; bu bir dış güvenlik sertifikası değildir.

## Temizlik ve uyumluluk

Ürün metinleri, belge bağlantıları, paket metadata bilgileri ve Canary kimliği Orkestra olarak düzenlendi. Eski hesabın otomatik yayın iş akışları, imzalama bilgileri, güncelleme tanımları, GitHub OAuth istemcisi ve kimlik sunucusu çıkarıldı. Geri bildirim ve otomatik güncelleme çalışma yolları devre dışıdır. Türkçe çeviri dosyaları artık depo içindedir; kişiye özel mutlak dosya yolu kullanılmaz.

`@emdash/*`, klasörler, başlık/protokol anahtarları ve eski kayıtları içe alan uyumluluk yolları korunmuştur. Apache-2.0 lisansı ve upstream atıfları `NOTICE`/`LICENSE.md` içindedir. Bu teknik ve yasal adlar kullanıcıya gösterilen ürün markasının parçası değildir.

Kod grafiği bu proje için indekslenemediğinden denetim kaynak/config metinleri ve ilgili testler üzerinden yapılmıştır. Tüm kod yollarının eksiksiz denetlendiği iddia edilmez.

## Açık sınırlamalar

Bu yayında tüm test paketi, canlı hesap oturumları, gerçek SSH makineleri ve platform kurulum paketleri yeniden uçtan uca denenmemiştir. Her sağlayıcının modelleri ve yetkileri hesabına göre değişebilir. Geliştirme arayüzündeki tüm metinler için eksiksiz Türkçe iddiası yoktur; paketlenen arayüzde çeviri adımı çalışır.

Google ortak OAuth uygulaması herkese açık doğrulamasını henüz tamamlamamıştır. Kullanıcıların kendi OAuth kayıtlarını sağlaması veya test hesabı olarak izinli olması gerekir. Hazır uzak sunucu arşivleri bu kaynak yayınıyla birlikte sunulmaz; dağıtım adresi açıkça yapılandırılmalıdır. Önceki projenin sunucularına geri dönüş yapılmaz.
