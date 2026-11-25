import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.omnisphere.camera360',
  appName: 'OmniSphere 360',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'always',
    preferredContentMode: 'mobile',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#05070d',
  },
  plugins: {
    OmniStitcher: {
      defaultOutputWidth: 4096,
      defaultJpegQuality: 92,
    },
  },
};

export default config;
