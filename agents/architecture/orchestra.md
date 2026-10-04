# Orkestra modu (çok ajanlı orkestrasyon)

"Sohbet Oluştur" modalındaki **Orkestra** girdisi, bir karar verici (şef) ajanın kurulu tüm ACP
destekli ajanları işçi olarak yönettiği bir sohbet açar. Şef gerçek bir ACP sohbetidir; işçiler
aynı görev worktree'sinde ayrı ACP sohbetleri olarak görünür.

## Akış

1. Renderer `conversations.orchestra.register` ile ayarları kaydeder, ardından şef sağlayıcısıyla
   normal bir ACP sohbeti oluşturur
   (`src/core/features/conversations/browser/create-conversation-modal.tsx`).
2. `attach` sırasında wire denetleyicisi, şef konuşmalarının `acpInput.mcpServers` alanına
   Orkestra MCP köprüsünü ekler (`src/core/features/conversations/node/wire-controller.ts`).
   Uzak (SSH) projelerde köprü, workspace-server ile gelen Node çalışma zamanıyla uzak makinede
   çalışır ve OpenSSH ters Unix soketi yönlendirmesiyle masaüstündeki RPC sunucusuna bağlanır
   (`src/core/features/orchestra/node/orchestra-remote-endpoint.ts`). Soket yolu uygulama oturumu
   boyunca sabittir; SSH yeniden bağlandığında yönlendirme aynı yola yeniden kurulur.
3. ACP çekirdeği bu konuşmaya özel stdio sunucularını sağlayıcının kendi MCP sunucularına ekler
   (`packages/core/src/runtimes/acp/node/runtime/mcp-servers.ts`, `withConversationMcpServers`).
4. Köprü (`src/core/features/orchestra/node/orchestra-mcp-bridge.ts`) bağımlılıksız bir
   `.cjs` betiğidir; Electron ikilisiyle `ELECTRON_RUN_AS_NODE=1` olarak çalışır ve araç
   çağrılarını `127.0.0.1` üzerindeki RPC sunucusuna iletir
   (`src/core/features/orchestra/node/orchestra-rpc-server.ts`).
5. `OrchestraService` (`src/core/features/orchestra/api/node/orchestra-service.ts`) işçi
   sohbetlerini ana süreçte oluşturur, `attach` + `sendPrompt` ile görev verir, tur sonucunu
   `loadHistory` üzerinden istem kimliğiyle eşleyerek son yanıtı rapor olarak döndürür.

## Güvenlik

- RPC sunucusu yalnızca loopback'e bağlanır; uzak erişim yalnızca SSH ters tüneliyle ve `700`
  izinli `~/.orkestra/orchestra` dizinindeki sokete gelir; her şef için bellekte tutulan 32 baytlık Bearer
  belirteci gerekir. Belirteç yalnızca o şefin köprü ortamına verilir ve diske yazılmaz.
- ACP'de `autoApprove` bir başlatma bayrağı değildir. "Ajan izinlerini otomatik onayla" açıkken
  servis bekleyen izin isteklerini `allow_once` (yoksa `allow_always`) seçeneğiyle yanıtlar;
  kapalıyken izinler kullanıcıya kalır ve şef hangi işçinin onay beklediğini bildirir.

## Kalıcılık ve öğrenme

`userData/orchestra/sessions.json` şef ayarlarını, işçi kayıtlarını ve sağlayıcı başına gözlenen
sonuç istatistiklerini (başarı oranı, ortalama süre) tutar. `list_agents` bu istatistikleri
yerleşik yönlendirme profilleriyle (`node/orchestra-playbook.ts`) birlikte şefe sunar.
