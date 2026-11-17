// app.json holds the config. With PROBE_APP_RTL=1, Metro serves the app in
// RTL: Expo Go applies forcesRTL from the manifest each time it loads the
// app, so a recorder restarts Metro and Expo Go to change the direction.
module.exports = ({ config }) =>
  process.env.PROBE_APP_RTL === '1'
    ? {
        ...config,
        extra: { ...config.extra, supportsRTL: true, forcesRTL: true },
      }
    : config
