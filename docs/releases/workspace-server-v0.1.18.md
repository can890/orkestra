# Workspace Server v0.1.18

- **Boşta sayılan yeni oturumlar:** Hiç istek almamış bir oturum artık açıldığı andan itibaren boşta kalma süresini bekler; bir dakika içinde kapatılıp yeniden açılmaz. Açılamayan boş sohbetlerin ve `session/close` desteklemeyen ajanlardaki takılmanın kaynağı buydu.
- **`session/close` desteklemeyen ajanlar:** "Method not found" yanıtı artık kapatılmış sayılır; sohbet "Önceki ajan oturumu henüz kapanmadı" hatasında kalmaz.
- **Alt ajanların gerçek durumu:** Yeniden açılan sohbette hâlâ çalışan alt ajan "çalışıyor", akıbeti bilinmeyen "durumu bilinmiyor" olarak gelir; bu satırlar oturumu meşgul göstermez.
- **Antigravity'de Durdur:** Tur açıkça durdurulduğunda o turun başlattığı arka plan komutu da sonlandırılır; sahipsiz çalışmaya devam etmez. Sohbeti kapatmak durdurma sayılmaz.
- **Yeni oturumla devam:** Kayıtlı oturumu kesin olarak bulunamayan bir sohbet, kullanıcı onayıyla yeni oturumla sürdürülebilir.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
