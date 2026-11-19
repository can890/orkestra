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

## GitHub ile giriş (QR'sız eşleşme)

Eşleşme ekranındaki "GitHub ile giriş yap" düğmesi, masaüstüyle aynı GitHub hesabını kullanarak QR
okutmadan eşleşir. Bağlantı yine yerel ağ/Tailscale üzerindendir; sunucu yoktur.

- `github-device-flow.ts` OAuth cihaz akışı (yalnızca `gist` izni); `github-http.ts` `github.com/login/*`
  uç noktalarını `CapacitorHttp` ile çağırır (bu uç noktalar tarayıcı CORS'una izin vermez; global
  `fetch` yaması açılmaz). `api.github.com` (buluşma belgesi) normal `fetch` ile çağrılır.
- `account-pairing-flow.ts`: belgeyi bulur, masaüstü seçilir (birden çoksa liste), telefon `request`
  yazar, sırrı `deriveAccountPairingSecret({ role: 'device' })` ile türetir ve QR yüküyle aynı
  `PairingPayload` biçimini üretip `AppSession.pair` ile kaydeder. Masaüstü cihazı kaydedip isteği
  belgeden silince bağlanmayı dener (en çok 3 dakika; istek silinmese de 30 sn'de bir dener).
  Kayıt gelmeden yapılan başarısız el sıkışmalar masaüstü hız sınırına (5 hata → kilit) işlendiği için
  her 5 sn kör deneme yapılmaz; belge ETag'li okuma ile izlenir.
- Yapılandırma: `VITE_ORKESTRA_GITHUB_CLIENT_ID` derleme zamanı değişkeni (`github-config.ts`); GitHub
  OAuth uygulamasında "Device Flow" etkin olmalı. Boşsa düğme pasif ve açıklama gösterilir; kodda
  sabit kimlik yoktur.
- Kalıcı olan: yalnızca olağan eşleşme kaydı (güvenli depo). GitHub erişim belirteci, cihaz kodu ve
  ECDH özel anahtarı yalnızca bellektedir (depoya, günlüğe, hata iletisine yazılmaz); akış bitince atılır.

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

GitHub girişini açmak için `vite build` öncesinde `VITE_ORKESTRA_GITHUB_CLIENT_ID=<istemci kimliği>` verilir.

Testler: `pnpm exec vitest run` (`apps/orkestra-mobile` içinde); tür denetimi:
`pnpm exec tsgo --noEmit -p tsconfig.json`.
