# v1.2.7 yayın kontrolü — 4 Ekim 2026

Bu sürümde kaynak kod, paket adları, yapılandırma anahtarları, test fixture veritabanları ve dağıtım varlıkları Orkestra adına geçirildi. GitHub `main` dalında güncel kaynaklar yayımlanır. Geçmişi yeniden yazma işlemi otomatik onay denetiminde reddedildiği için eski commitler dalın geçmişinde kalır. Eski veri konumları için otomatik geçiş bulunmaz.

## Doğrulama

- `pnpm install --frozen-lockfile` başarılı.
- `pnpm run format`, `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` ve üretim derlemesi başarılı.
- Takip edilen dosyalarda eski ürün adına ilişkin bayt taraması sıfır eşleşme verdi. Gizli anahtar desenleri yalnızca redaction testlerindeki sahte örneklerde görüldü.
- Codex ACP fixture, gerçek kullanıcı oturumu yerine sentetik bir örnekle test edilir.
- Test paketinde dosya izleme olaylarına bağlı 6 test bu macOS yürütme ortamında zaman aşımına uğradı. Bağımsız `@parcel/watcher` denemesi de geçici klasörde hiç olay üretmedi. Bu nedenle gerçek dosya izleme akışı bu ortamda doğrulanmış sayılmaz.
- Masaüstü Node, veritabanı ve betik testlerinde 4.172 test geçti, 3 test atlandı. Migration testlerinde 70 test geçti. Diğer workspace paket testleri geçti; Core içinde 1.945 test geçti, 1 test atlandı ve dosya izlemeye bağlı 6 test zaman aşımına uğradı.
- Tam browser paketi bu ortamda birkaç dosyada zaman aşımına uğradı ve baştan sona başarılı bitmedi. Türkçe arayüzle uyumsuz iki test seçicisi düzeltildi. Sorunlu dosyalar ayrı çalıştırıldığında PTY düzeni 17/17, ACP başlangıç düzeni 16/16, MCP çekmecesi 3/3, Monaco diff 8/8 ve kurulum ayarları 5/5 geçti.
- Apple Silicon ve Intel uygulama paketleri 1.2.7 sürümünü taşıyor; imza yapıları ve yerel modüllerin mimarileri doğrulandı. Her iki DMG için `hdiutil verify`, her iki ZIP için `unzip -t` başarılı. Dosya özetleri `SHA256SUMS` ile yayımlanır. Apple Silicon uygulaması ayrı boş profille 12 saniyelik denemede erken kapanmadı; kullanıcı arayüzü uçtan uca doğrulanmadı.

## Dağıtım sınırları

Apple Developer ID kimliği bu makinede bulunmadığından macOS paketleri Apple tarafından onaylanmış değildir. İlk açılışta macOS güvenlik izni gerekebilir. Intel paketi arm64 makinede üretildi; Rosetta bulunmadığı için Intel uygulaması burada çalıştırılamaz. Linux ve Windows kurulum paketleri bu sürümde yayımlanmaz.

Google ortak OAuth uygulaması herkese açık doğrulamasını tamamlamamıştır. Kullanıcı kendi OAuth kaydını sağlayabilir veya izinli test hesabı kullanabilir. Uzak çalışma alanı sunucusu arşivleri bu sürümde sunulmaz; kurulum adresi açıkça yapılandırılmalıdır. Otomatik güncelleme kapalıdır.
