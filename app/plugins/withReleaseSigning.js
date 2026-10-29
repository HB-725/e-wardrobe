/**
 * Signs release builds with the keystore named by the EW_KEYSTORE* environment variables (see HANDOFF.md).
 * Without them the release build falls back to the debug key, which is fine for local testing only.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const BLOCK = `
        release {
            def ks = System.getenv('EW_KEYSTORE')
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv('EW_KEYSTORE_PASSWORD')
                keyAlias System.getenv('EW_KEY_ALIAS') ?: 'ewardrobe'
                keyPassword System.getenv('EW_KEY_PASSWORD') ?: System.getenv('EW_KEYSTORE_PASSWORD')
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents;
    if (g.includes("System.getenv('EW_KEYSTORE')")) return cfg;
    g = g.replace(/(signingConfigs\s*\{\s*\n\s*debug\s*\{[^}]*\})/, `$1${BLOCK}`);
    g = g.replace(
      /(release\s*\{\s*\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/,
      "$1signingConfig System.getenv('EW_KEYSTORE') ? signingConfigs.release : signingConfigs.debug",
    );
    if (!g.includes('signingConfigs.release')) throw new Error('withReleaseSigning: build.gradle layout changed');
    cfg.modResults.contents = g;
    return cfg;
  });
};
