#!/bin/sh
# Orkestra macOS sürümleri için kalıcı, kendinden imzalı bir kod imzalama kimliği kurar.
#
# Ad-hoc imzada uygulamanın kimliği her derlemede değişir; macOS da Anahtar Zinciri erişimini
# (Orkestra Safe Storage) her güncellemeden sonra yeniden sorar. Aynı sertifikayla imzalanan
# sürümler aynı kimliği taşıdığı için izin bir kez verildikten sonra tekrar sorulmaz.
# Apple Developer ID'nin yerini tutmaz: Gatekeeper ilk açılışta yine uyarır.
#
# Kimlik ~/.orkestra-signing (ORKESTRA_SIGNING_DIR) içindeki ayrı bir anahtar zincirinde durur.
# Kullanıcının giriş anahtar zincirine, güven ayarlarına ve arama listesine dokunulmaz.
# Bu klasörü yedekleyin ve paylaşmayın; kaybolursa kimlik değişir ve onay bir kez daha sorulur.
set -eu

DIR="${ORKESTRA_SIGNING_DIR:-$HOME/.orkestra-signing}"
NAME="Orkestra Code Signing"
KEYCHAIN="$DIR/signing.keychain-db"

if [ -f "$KEYCHAIN" ]; then
  echo "İmza kimliği zaten kurulu: $KEYCHAIN"
  exit 0
fi

umask 077
mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

KEYCHAIN_PASSWORD=$(/usr/bin/openssl rand -hex 24)
IDENTITY_PASSWORD=$(/usr/bin/openssl rand -hex 24)

cat >"$TMP/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $NAME

[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

/usr/bin/openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -config "$TMP/openssl.cnf" -keyout "$TMP/key.pem" -out "$DIR/certificate.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$NAME" -inkey "$TMP/key.pem" -in "$DIR/certificate.pem" \
  -out "$DIR/identity.p12" -passout "pass:$IDENTITY_PASSWORD"
printf '%s' "$KEYCHAIN_PASSWORD" >"$DIR/keychain-password"
printf '%s' "$IDENTITY_PASSWORD" >"$DIR/identity-password"

# create-keychain anahtar zincirini arama listesine ekleyebilir; kullanıcının listesi aynen kalsın.
SEARCH_LIST=$(security list-keychains -d user)
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
eval "security list-keychains -d user -s $SEARCH_LIST"

security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$DIR/identity.p12" -k "$KEYCHAIN" -P "$IDENTITY_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN" >/dev/null

echo "İmza kimliği kuruldu: $NAME"
echo "Konum: $DIR (yedekleyin, paylaşmayın)"
echo
echo "macOS yalnızca güvenilen sertifikalarla kod imzalatır. Bir kez şu komutu çalıştırın"
echo "(sertifikayı yalnızca kod imzalama için güvenilir yapar; macOS parolanızı sorar):"
echo "  security add-trusted-cert -r trustRoot -p codeSign -k \"$KEYCHAIN\" \"$DIR/certificate.pem\""
