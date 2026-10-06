# Workspace Server v0.1.12

Orkestra v1.2.23 düzeltmesinin uzak (SSH) makinelere ulaşan kısmı:

- **Yeniden açılan Grok sohbetleri temiz görünüyor:** Grok geçmişi geri oynatırken Orkestra'nın arka planda gönderdiği `/always-approve on/off` komutları ve isteme eklenen gizli talimat metni kullanıcı mesajına karışıyordu. Uzak makinede çalışan sohbetlerde de artık yalnızca kullanıcının yazdığı metin görünüyor.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası. GitHub Actions'ta Docker ile derlendi ve `debian:bookworm-slim` içinde başlat/durum/durdur denetiminden geçti.
