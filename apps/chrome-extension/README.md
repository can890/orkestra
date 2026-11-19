# Orkestra Chrome uzantısı

Orkestra masaüstündeki ajanların, kendi oturumlarınızla açık Chrome'unuzu kullanabilmesini sağlar.
Paketlenmemiş (unpacked) bir MV3 uzantısıdır; derleme adımı yoktur.

## Kurulum

1. Orkestra > Ayarlar > **Chrome** sayfasında "Chrome köprüsü"nü açın (varsayılan kapalıdır) ve
   eşleştirme belirtecini kopyalayın.
2. Chrome'da `chrome://extensions` sayfasını açın, **Geliştirici modu**nu etkinleştirin.
3. **Paketlenmemiş öğe yükle** ile bu klasörü (`apps/chrome-extension/`) seçin.
4. Uzantı simgesi > **Ayarlar**: belirteci yapıştırıp **Kaydet ve bağlan**'a basın. Bağlantı noktası
   Orkestra'dakiyle aynı olmalıdır (varsayılan 47653).
5. Ajanın kullanacağı sitede uzantı simgesine tıklayıp **Bu siteye izin ver**'e basın. İzin vermediğiniz
   sitelerde ajan hiçbir işlem yapamaz.

Köprü açıkken ve uzantı bağlıyken başlayan yeni sohbetlere `orkestra-chrome` araçları eklenir
(`tabs_list`, `tab_create`, `navigate`, `read_page`, `click`, `type`, `screenshot`).

## Güvenlik

- Yalnızca `127.0.0.1` üzerinden masaüstüne bağlanır; ajan bu uzantıdan başka bir şeye erişemez.
- Site izinleri isteğe bağlıdır ve yalnızca sizin uzantı arayüzündeki tıklamanızla verilir.
- Şifre ve ödeme kartı alanlarına yazılmaz; `chrome://`, uzantı, Web Mağazası ve `file://` sayfalarında
  işlem yapılmaz; çerez, geçmiş, parola ve indirme erişimi yoktur.
- Ajan bir sekmede işlem yaparken simgede **AI** rozeti görünür. Popup'taki **Bağlantıyı kes** her şeyi durdurur.
- Belirteci yenilemek (Orkestra > Chrome) eski belirteci geçersiz kılar.
