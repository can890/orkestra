# Workspace Server v0.1.21

- **Antigravity'de canlı yönlendirme:** Standart modelle açılan Antigravity oturumları artık `agy acp` üzerinden sürülür; ajan çalışırken gönderilen mesaj çalışan turun içine girer, çalışan komut ve arka plan görevi kesilmez. Kurulu `agy` bunu desteklemiyorsa ya da oturum orkestratör modeliyle açıldıysa eski stream-json yolu kullanılır ve mesaj tur bitince gönderilir. `ORKESTRA_AGY_TRANSPORT=acp|stream-json|auto` ile seçilebilir.
- **Sıradaki mesajın nedeni:** Tura alınamayan mesajla birlikte isteğe bağlı bir neden taşınır (ajan çalışırken mesaj alamıyor, orkestratör kipi, izin bekleniyor, bağlanıyor); istemciler bunu sıra bandında gösterir.
- **Her ajanın alt ajanları:** Codex'in çoklu ajan araçları (`spawn_agent`, `wait_agent`, `send_message`, `interrupt_agent`) alt ajan olaylarına çevrilir; durum, model, görev ve adımlar alt ajanın kendi kaydından okunur. Kimi, Grok, GLM ve özel ACP ajanlarının `run_subagent` çağrıları da alt ajan olarak bildirilir.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
