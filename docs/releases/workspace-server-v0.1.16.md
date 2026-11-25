# Workspace Server v0.1.16

- **Antigravity'de kaybolan mesajlar:** Ajan arka plan işi beklerken gönderilen mesaj artık "iletildi" sayılıp sessizce düşmüyor. agy mesajı gerçekten işlemeye başlamazsa tur iptal edilip mesaj yeni istek olarak gönderilir; okunmamış satır tutan bir agy süreci yeniden kullanılmaz.
- **Tur canlılığı:** Oturum durumu, turun ne zaman başladığını ve ajanın en son ne zaman bir şey gönderdiğini bildirir; masaüstü uzun süre sessiz kalan turu "Çalışıyor…" diye bekletmek yerine açıklar.
- **Bayt aralığıyla dosya okuma:** Dosya çalışma zamanı `offset`/`length` ile okumayı destekler; sohbetteki büyük video ve sesler SFTP yedeğine düşmeden, sarma destekli akar.
- **Arka plan görev izleme ve servis yönetimi:** Claude arka plan görevlerinin bitişi oturum dökümünden izlenir; sunucu kullanıcı servisi olarak kurulup yönetilebilir.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
