# Workspace Server v0.1.22

- **Antigravity'nin kendi alt ajanları:** Standart modelle açılan Antigravity oturumlarında (`agy acp`) `invoke_subagent` çağrıları alt ajan olayına çevrilir; durum, model, adımlar ve son yanıt alt ajanın kendi kaydından okunur. Alt ajanın kendi araç çağrıları ana sohbete satır olarak düşmez. Orkestratör modelli oturumlar ve stream-json yolu değişmedi.
- **Alt ajan ayarları ve yerleşik alt ajan MCP'si:** Alt ajan politikası ve görev aktarımı oturum çalışma zamanına taşındı; Codex alt ajan görevleri ana oturumun ayarlarını devralır.
- **Git checkout:** Parça (hunk) düzeyinde yama uygulama ve diff ayrıştırma eklendi.

Protokol 10.1; 10.x istemcilerle uyumludur. Linux x64 arşivi ve SHA-256 doğrulama dosyası.
