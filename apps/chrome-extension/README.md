# Orkestra Chrome Köprüsü

Orkestra masaüstündeki ajanların, kendi oturumlarınızla açık Chrome sekmelerinizi ek izin veya
belirteç eşleştirmesi gerekmeden doğrudan kullanabilmesini sağlar. Paketlenmemiş (unpacked) bir MV3
uzantısıdır; derleme adımı yoktur.

## Kurulum

1. Chrome'da `chrome://extensions` sayfasını açın, **Geliştirici modu**nu etkinleştirin.
2. **Paketlenmemiş öğe yükle** ile uzantı klasörünü seçin.
3. Uzantı yüklendiği anda yerel Orkestra masaüstü uygulamasına (`127.0.0.1:47653`) otomatik olarak
   bağlanır.

## Araç Seti (18 Eylem)

- Sekme yönetimi: `tabs_list`, `tab_create`, `tab_close`, `tab_select`, `navigate`
- Sayfa okuma ve arama: `read_page`, `find`, `get_page_text`, `screenshot`
- Etkileşim: `click`, `type`, `form_input`, `press_key`, `scroll`
- Gelişmiş & tanı: `evaluate`, `wait_for`, `console`, `network`

## Güvenlik

- Yalnızca `127.0.0.1` üzerinden yerel masaüstüne bağlanır.
- Yalnızca `http://` ve `https://` sayfalarında çalışır; `chrome://`, `file://`, `devtools://`,
  `chrome-extension://`, `about:` ve Chrome Web Mağazası sayfaları engellidir.
- Şifre (`type="password"`) ve ödeme kartı (`cc-*`) alanları okunmaz ve bu alanlara yazılmaz.
- Uzantı popup'ındaki **Duraklat** düğmesiyle bağlantı tek tıkla duraklatılabilir.
