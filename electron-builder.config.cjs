const { build: baseBuild } = require('./package.json');

module.exports = () => {
  const build = structuredClone(baseBuild);
  const macSigningConfigured = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
  const apiKeyFields = [
    process.env.APPLE_API_KEY,
    process.env.APPLE_API_KEY_ID,
    process.env.APPLE_API_ISSUER,
  ];
  const anyApiKeyField = apiKeyFields.some(Boolean);
  const completeApiKey = apiKeyFields.every(Boolean);

  if (anyApiKeyField && !completeApiKey) {
    throw new Error('Set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER together.');
  }
  if (macSigningConfigured !== completeApiKey) {
    throw new Error('macOS signing and notarization must be configured together.');
  }

  const mac = { ...build.mac };
  delete mac.identity;
  if (macSigningConfigured) {
    mac.hardenedRuntime = true;
    mac.notarize = true;
    // The app is notarized by electron-builder; the DMG around it is signed
    // here and notarized + stapled by the hook, so the downloaded image passes
    // Gatekeeper too.
    build.dmg = { ...build.dmg, sign: true };
    build.afterAllArtifactBuild = './scripts/notarize-dmg.mjs';
  } else {
    mac.identity = null;
    mac.hardenedRuntime = false;
    mac.notarize = false;
  }
  build.mac = mac;
  return build;
};
