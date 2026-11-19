# Eklenti paketleri ve marketplace

Claude Code eklenti biçimindeki paketleri (`.claude-plugin/plugin.json`, `skills/`, `commands/`,
`agents/`, `hooks/hooks.json`, `.mcp.json`) ve marketplace dizinlerini
(`.claude-plugin/marketplace.json`) kurar. Kod: `src/core/features/plugin-packs/`
(`api/` contract, `node/` servis ve controller, `browser/` Ayarlar > Eklentiler sayfası).

## Akış

1. **Marketplace ekle** — `parseMarketplaceSource` yalnızca `https://` git URL'si ya da GitHub
   `owner/repo` kabul eder (`file://`, `ssh://`, `git://`, yerel yol, `-` ile başlayan değer, kullanıcı
   bilgisi reddedilir). `git-clone.ts` argv dizisiyle ve `--` ile `git clone --depth 1` çalıştırır
   (`protocol.allow=never`, yalnız https, şablon hook'ları ve LFS filtreleri kapalı, alt modül yok,
   `GIT_TERMINAL_PROMPT=0`, env allowlist). Klon `userData/plugin-packs/marketplaces/<id>/` altına
   geçici dizinden `rename` ile yerleşir.
2. **İncele** — `previewPlugin` kurulacakları çıkarır: skill adları, prompt komutları, **çalıştırılacak
   MCP komutlarının tam metni** (`${CLAUDE_PLUGIN_ROOT}` çözülmüş), desteklenmeyenler (hook, alt ajan,
   `sse` MCP) ve mevcut kayıtlarla çakışmalar. Yanıttaki `digest` tüm içeriğin SHA-256'sıdır.
3. **Kur** — `installPlugin` içeriği yeniden okur; `digest` onaylanandan farklıysa ya da çakışma varsa
   hiçbir şey kaydetmez. Skill'ler `agentConfig.installSkill` (yalnız `SKILL.md`; yanındaki script ve
   dosyalar kopyalanmaz), MCP sunucuları `agentConfig.saveMcpServer` (ad: `<eklenti>-<sunucu>`),
   komutlar prompt kütüphanesine (`plugin-pack:<marketplace>:<eklenti>:<komut>`) yazılır. Yarıda hata
   olursa eklenenler geri alınır.
4. **Kaldır** — `uninstallPlugin` yalnızca köken kaydındaki öğeleri siler. Kurulumdan sonra
   değiştirilmiş kayıt (içerik özeti farklı) silinmez, "korunan" olarak bildirilir. Kullanıcının
   kendi aynı adlı kaydı kurulumda çakışma sayılıp kurulumu engellediği için zaten ezilmez.

## Güvenlik kuralları

- Eklentiden gelen hiçbir script, hook ya da ikili klon sırasında veya sonrasında çalıştırılmaz;
  `hooks/` yalnızca listelenir. (Kurulan MCP sunucuları kullanıcı onayıyla ajan oturumlarında çalışır;
  bu yüzden komutlar tam metinle gösterilir.)
- Eklenti içindeki her yol `safe-path.ts` ile kök içinde doğrulanarak okunur: mutlak yol, `..` ve
  kök dışına çıkan symlink reddedilir; dosya boyutu ve sayıları sınırlıdır.
- Şimdilik yalnızca yerel host desteklenir (MCP komutları klon dizinine işaret eder). Harici
  (`github`/`url` nesne) eklenti kaynakları desteklenmez; yalnızca marketplace içi göreli yollar.

## Kalıcı durum

`userData/plugin-packs/state.json` — `defineVersionedSchema` ile sürümlü (v1): marketplace'ler ve
kurulum başına köken kayıtları (skill/MCP/komut kimlikleri + içerik özeti). DB migration'ı yoktur.
Yazma atomiktir (geçici dosya + rename) ve işlemler sıraya konur.

## Testler

`node/*.test.ts`, `api/marketplace-source.test.ts` — ağsız: `os.tmpdir()` altında sahte eklenti
dizinleri ve enjekte edilen clone fonksiyonu kullanılır.
