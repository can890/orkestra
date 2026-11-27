import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.orkestra.mobile',
  appName: 'Sovra',
  webDir: 'dist',
  server: {
    // WebView sayfası http://localhost'tan yüklenir (localhost güvenli bağlamdır: WebCrypto çalışır).
    // https olsaydı ws:// ile masaüstüne bağlanmak karma içerik olarak engellenirdi.
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#090A0D',
  },
  plugins: {
    SystemBars: {
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
