# Workspace Server v0.1.20

- **Tur, gönderilen mesaj yüzünden durdurulmaz:** Ajan çalışırken gelen mesaj tura alınamıyorsa (yönlendirme desteği yok, ajan reddetti, izin isteği açık, arka plan görevi sürüyor) artık sıranın sonuna eklenir ve tur bitince kendiliğinden gönderilir. Çalışan tur yalnızca kullanıcı açıkça durdurduğunda ya da sıradaki mesajda "Şimdi gönder" dediğinde durur.
- **Antigravity:** Çalışan tura yazılan mesaj hemen sıraya alınır. Mesajın 10 saniye bekletilip ardından turun durdurulması kaldırıldı; `agy` yeni mesajı zaten ancak tur bittikten sonra okuyor.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
