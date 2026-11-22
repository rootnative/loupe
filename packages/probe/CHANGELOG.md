# Changelog

All notable changes to `@rootnative/loupe-probe` are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow modified semver: a breaking change bumps the middle digit (`0.1.0`), and fixes and additions bump the last digit (`0.0.2`).

## [Unreleased]

### Added

- **`<LoupeProbe />`**. Render it once, inside your `SafeAreaProvider`. In development it gives loupe the safe-area insets, the window size, the scale, the layout direction, the colour scheme, and the `route` that you pass. It renders nothing in a release build.
- Peer dependencies: `react` 18 or later, `react-native` 0.73 or later, and `react-native-safe-area-context` 4 or later.

[unreleased]: https://github.com/rootnative/loupe/commits/main
