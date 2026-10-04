# v1.2.7 yayın kontrolü — 4 Ekim 2026

Bu sürümde kaynak kod, paket adları, yapılandırma anahtarları, test fixture veritabanları ve dağıtım varlıkları Orkestra adına geçirildi. GitHub `main` dalında güncel kaynaklar yayımlanır. Geçmişi yeniden yazma işlemi otomatik onay denetiminde reddedildiği için eski commitler dalın geçmişinde kalır. Eski veri konumları için otomatik geçiş bulunmaz.

## Doğrulama

- `pnpm install --frozen-lockfile` başarılı.
- `pnpm run format`, `pnpm run lint`, `pnpm run typecheck` ve üretim derlemesi başarılı.
- Takip edilen dosyalarda eski ürün adına ilişkin bayt taraması sıfır eşleşme verdi. Gizli anahtar desenleri yalnızca redaction testlerindeki sahte örneklerde görüldü.
- Codex ACP fixture, gerçek kullanıcı oturumu yerine sentetik bir örnekle test edilir.
- Test paketinde dosya izleme olaylarına bağlı 6 test bu macOS yürütme ortamında zaman aşımına uğradı. Bağımsız `@parcel/watcher` denemesi de geçici klasörde hiç olay üretmedi. Bu nedenle gerçek dosya izleme akışı bu ortamda doğrulanmış sayılmaz.
- Diğer test sonuçları ve macOS paket denetimi sürüm oluşturulurken kaydedilir.

## Dağıtım sınırları

Apple Developer ID kimliği bu makinede bulunmadığından macOS paketleri Apple tarafından onaylanmış değildir. İlk açılışta macOS güvenlik izni gerekebilir. Intel paketi arm64 makinede üretildi; Rosetta bulunmadığı için Intel uygulaması burada çalıştırılamaz. Linux ve Windows kurulum paketleri bu sürümde yayımlanmaz.

Google ortak OAuth uygulaması herkese açık doğrulamasını tamamlamamıştır. Kullanıcı kendi OAuth kaydını sağlayabilir veya izinli test hesabı kullanabilir. Uzak çalışma alanı sunucusu arşivleri bu sürümde sunulmaz; kurulum adresi açıkça yapılandırılmalıdır. Otomatik güncelleme kapalıdır.
