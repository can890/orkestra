# Workspace Server v0.1.17

- **Antigravity arka plan görevleri görünür:** Ajan uzun bir arka plan işi (görsel/video üretimi gibi) yürütürken sohbette çalışan komut canlı bir satır olarak görünür; görev bitince tamamlandı ya da başarısız olarak kapanır. Ajanın "başlattım, bekliyorum" yanıtı görev bitmeden ekrana gelir.
- **Görev sürerken gönderilen mesaj:** agy bu sırada girdi okumadığı için mesaj artık turu durdurmaz; sıraya alınır ve tur bitince iletilir. Turu durdurmak görevi sahipsiz bırakıp aynı işin yeniden başlatılmasına yol açıyordu.
- **Geçmişteki alt ajan satırları:** Sohbet yeniden açıldığında alt ajan satırları artık düşmez; sözleşme dışı tür taşıyan eski satırlar atılmak yerine onarılır.
- **İlk mesajı almamış sohbetler:** Hiç istek gönderilmeden askıya alınan bir oturum yüklenemezse sohbet yeni oturumla açılır; istek almış oturumlar korunur.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
