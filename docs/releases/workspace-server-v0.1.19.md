# Workspace Server v0.1.19

- **Biten alt ajan "çalışıyor" kalmıyor:** Bitiş bildirimi artık ajanın kimliğiyle eşleştirilir ve ajanı başlatan satıra işlenir. `SendMessage` ile yeniden başlatılan bir ajanın ikinci bitişi başlatma satırını kapatır; yeniden başlatılan ajan iş sürerken "çalışıyor" görünür.
- **Yeniden açılan sohbetler:** Geri yüklenen bir oturumda bitişi kayıtta bulunamayan alt ajan, süresiz "çalışıyor" yerine "sonuç bilinmiyor" olarak kapanır. Tur ortasında tüketilen bitiş bildirimleri oturum kaydından okunur.
- **İzleme yükü:** İzlenen alt ajan kalmadığında oturum kaydı yoklaması durur.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
