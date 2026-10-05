#!/bin/sh
# Kullanım: sign-mac-local.sh <Orkestra.app>
#
# Uygulamayı setup-mac-signing.sh ile kurulan kalıcı kimlikle imzalar; böylece her sürüm aynı
# kod imzası kimliğini taşır ve macOS güncellemeden sonra Anahtar Zinciri iznini yeniden sormaz.
# macOS yalnızca kod imzalama için güvenilen sertifikalarla imzalatır. Kimlik kurulu ya da
# güvenilir değilse yapılması gerekeni yazdırıp ad-hoc imzaya döner.
set -eu

APP="${1:?Kullanım: sign-mac-local.sh <Orkestra.app>}"
DIR="${ORKESTRA_SIGNING_DIR:-$HOME/.orkestra-signing}"
NAME="Orkestra Code Signing"
KEYCHAIN="$DIR/signing.keychain-db"
SIGNED=""

# Finder ve indirme meta verileri imzayı bozar.
xattr -cr "$APP"

if [ -f "$KEYCHAIN" ] && [ -f "$DIR/keychain-password" ]; then
  security unlock-keychain -p "$(cat "$DIR/keychain-password")" "$KEYCHAIN"
  if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
    codesign --force --deep --timestamp=none --keychain "$KEYCHAIN" --sign "$NAME" "$APP"
    SIGNED=1
  else
    echo "Uyarı: \"$NAME\" sertifikası kod imzalama için henüz güvenilir değil." >&2
    echo "Bir kez şu komutu çalıştırın (macOS parolanızı sorar):" >&2
    echo "  security add-trusted-cert -r trustRoot -p codeSign -k \"$KEYCHAIN\" \"$DIR/certificate.pem\"" >&2
  fi
else
  echo "Uyarı: kalıcı imza kimliği yok (önce setup-mac-signing.sh)." >&2
fi

if [ -z "$SIGNED" ]; then
  echo "Ad-hoc imzalanıyor; macOS güncellemeden sonra Anahtar Zinciri iznini yeniden sorabilir." >&2
  codesign --force --deep --sign - "$APP"
fi

codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep 'designated'
