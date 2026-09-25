/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.arcai.sutra',
  appName: '抄经',
  webDir: 'www',
  // 前端资源打包进 App 本地，API 走远端 https://scri.arcai.com（见 app.js API_BASE）
  server: {
    androidScheme: 'https',
    allowNavigation: ['scri.arcai.com'],
  },
  android: {
    allowMixedContent: false,
  },
};

module.exports = config;
