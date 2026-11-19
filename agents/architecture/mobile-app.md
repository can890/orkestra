# Mobil uygulama (Android)

`apps/orkestra-mobile/` (`@orkestra/orkestra-mobile`): Vite + React + Capacitor (Android). Masaüstündeki
Orkestra'ya QR ile eşleşir ve [uzak erişim protokolünü](remote-access.md) konuşur. Bulut yoktur; ajanlar
ve sağlayıcı token'ları masaüstünde kalır. Protokol ve izin listesi tek kaynaktan gelir; bu uygulama
onları yeniden yazmaz: taşıma, şifreleme, el sıkışma ve yeniden bağlanma `@orkestra/wire`'dan
(`@orkestra/wire/remote`, `@orkestra/wire/rpc`, `@orkestra/wire/live`) kullanılır.

## Yerleşim

- `src/core/` — saf, vitest ile testli mantık (React yok):
  - `pairing.ts` QR yükü ayrıştırma/doğrulama; `pairing-store.ts` kayıt + `SecureStore` arayüzü;
    `secure-store.ts` Android Keystore destekli depo (`capacitor-secure-storage-plugin`).
  - `connection-state.ts` durum makinesi ve hata sınıflandırması; `connection-manager.ts`
    `reconnectingTransport` + `connectRemoteTransport` ile adres yedekleme ve otomatik yeniden bağlanma.
  - `wire-client.ts` izinli yordam/konu adları, `Result` açma, canlı konu aboneliği (`ReplicaState`).
  - `mappers.ts` masaüstü yanıtlarından görünüm modellerine gevşek eşleme (`unknown` girdi).
  - `transcript-store.ts`, `conversation-session.ts` sohbet dökümü (geçmiş sayfaları + canlı etkin tur),
    prompt/iptal/izin eylemleri. `app-session.ts` eşleşme yaşam döngüsü.
- `src/ui/` — React ekranları (Türkçe, dar görünüm, ≥44px dokunma hedefi, açık/koyu tema).
  Gezinme `history` API'sidir (Android geri düğmesi WebView geçmişinde geri gider).
- `src/testing/fake-desktop.ts` — masaüstü yüzeyini taklit eden test denetleyicisi;
  `src/core/e2e.test.ts` gerçek `listenRemoteServer` ile `127.0.0.1` üzerinde uçtan uca sınar.
- `android/` — Capacitor Android projesi (`android/build`, `android/app/build` git'e girmez).

## Kurallar

- Yalnızca `remote-surface.ts` izin listesindeki yordamlar/konular çağrılır (`wire-client.ts`
  `REMOTE_PROCEDURES`/`REMOTE_TOPICS`). Yeni bir uç nokta gerekirse masaüstü izin listesi ve
  `remote-access.md` birlikte güncellenir; mobil tarafta tek başına eklenmez.
- Eşleştirme sırrı yalnızca güvenli depoya yazılır; düz `localStorage`/Preferences yok. Sır
  loglanmaz, hata/arayüz metnine konmaz. Tarayıcıda (yerel olmayan ortam) bellek deposu kullanılır.
- Manifest: yalnızca `INTERNET`; `usesCleartextTraffic` LAN `ws://` adresleri için gerekir (taşıma
  uygulama katmanında şifreli). `capacitor.config.ts` `androidScheme: 'http'` ile `ws://` karma
  içerik sayılmaz; `localhost` güvenli bağlam olduğundan WebCrypto çalışır.
- Telefondan açılabilen sohbetler yalnızca ACP sohbetleridir; terminal (PTY) oturumları gösterilir
  ama açılamaz.

## Derleme

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd apps/orkestra-mobile
pnpm exec vite build && pnpm exec cap sync android
cd android && ./gradlew assembleDebug --no-daemon && ./gradlew --stop
# çıktı: android/app/build/outputs/apk/debug/app-debug.apk
```

Testler: `pnpm exec vitest run` (`apps/orkestra-mobile` içinde); tür denetimi:
`pnpm exec tsgo --noEmit -p tsconfig.json`.
