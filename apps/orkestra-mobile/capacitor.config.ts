import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.orkestra.mobile',
  appName: 'Orkestra',
  webDir: 'dist',
  android: {
    // Kamera yalnızca QR taraması içindir; WebView'dan karışık içerik açılmaz.
    allowMixedContent: false,
  },
};

export default config;
