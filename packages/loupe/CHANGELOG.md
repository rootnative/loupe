# Changelog

All notable changes to `@rootnative/loupe` are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow modified semver: a breaking change bumps the middle digit (`0.1.0`), and fixes and additions bump the last digit (`0.0.2`).

## [Unreleased]

### Added

- **`expo-warm`**: it asks Metro (`npx expo start`) for the manifest of your app and its launch bundle, as Expo Go does on its first open. Then the first open doesn't wait for a cold bundle. It gives the SDK version and the folder of the app, and the time, the size, and the SHA-256 of the bundle: after an edit, the same hash means that Metro didn't see the edit. It asks Metro on 127.0.0.1 only.
- **`expo-open`**: it opens your app in Expo Go at a route, through `adb reverse` of the port of Metro. It warms the bundle first, closes Expo Go's onboarding sheet and developer menu, opens the link again when Expo Go loses it, and waits until the app shows: on the route when your app has the probe. With no probe, it waits until the screen has text, a label or a touch and keeps still, then reads it once more, so a loading screen or a sheet that comes a moment later isn't taken for your app. It warns when Expo Go isn't for the SDK of your app, and with no Expo Go it says how to install it.
- **`expo-reload`**: it stops Expo Go and opens your app again, so its JavaScript starts again in a new process. It opens the route that the probe shows before the stop, or the route that you give, else the root. It warms the bundle first, so it stops nothing when Metro doesn't run. After the stop, it waits until the process of Expo Go is gone, then opens the link. It warns when Android didn't start Expo Go cold.
- **`expo-rtl`**: `expo-rtl on` writes `supportsRTL` and `forcesRTL` in the `extra` of your app.json, and opens your app again in RTL, as `expo-reload` does. It keeps app.json as it was in `.expo/loupe-rtl.json`, and `expo-rtl off` puts it back byte for byte. It finds app.json through the manifest of Metro, waits until the manifest has the change, and waits until the probe shows the direction. When the manifest doesn't get the change (an `app.config.js` that replaces `extra`), it puts app.json back and says why. A project with no app.json gets `unsupported`, with the two lines to add.
- **`direction` and `reopens`** in the output of `expo-open`, `expo-reload` and `expo-rtl`: the layout direction that the probe shows, and what loupe saw before each time that it opened the link again.
- **`sweep --reload-every <n>`**: it stops the app before each n-th link that the sweep opens, over all the variants, and the link starts it again, so stacked screens don't slow the app down. In Expo Go, loupe then waits until the app shows the route of the link, as `expo-open` does. It needs `--app`. Each screen in the report has `reloaded`.
- **The error code `no_server`**: nothing answers on the port of Metro, or the server there isn't Metro.

### Fixed

- `dismiss` sends Back or Escape only when the input focus is on the layer that it closes. On a busy device, Android moves the input focus a moment after the window focus. A Back right after the notification shade closed could reach the shade, and the share sheet under it stayed open. When the input focus doesn't arrive within the limit, `dismiss` gives `timeout` and sends no key.

## [0.0.0-alpha.1] - 2026-11-24

loupe drives an Android emulator or device, measures each screen of your app in dp, and gives your agent "pass" or "fail" with the numbers. It works on Android 11 (API level 30) and later.

### Added

- **The CLI**, `loupe`. It prints JSON through a pipe and text in a terminal. Exit codes: 0 passed, 1 failed, 2 a wrong command or flag, 130 cancelled.
- **The MCP server**, `loupe mcp`. Each command is a tool, with the schemas of its input and its output. A sweep sends its progress, and a cancelled call stops at a safe point. `screenshot` and `sweep` also give their images in the result.
- **The skill**, `skills/loupe/SKILL.md`: the workflow, the rules, and what to do for each error. It tells your agent to ask you before it starts an emulator or opens an app. The MCP server serves it too.
- **`check`**, with five rules: `inset`, `overflow`, `centred`, `touch-target`, and `mirrored`. Each finding gives the element and its numbers in dp.
- **`sweep`**: it checks each link in each orientation and theme, and with `scroll` once more after a scroll down. It writes `report.json`, a screenshot of each screen, and a contact sheet of each variant. Then it puts the orientation and the theme back.
- **Reads:** `screenshot` (upright, with a crop and a scale), `ui` (the accessibility tree, with frames in dp), `insets` (the system bars, the cutout, and the safe area), `measure` (the colour runs along a row or a column, and where an element sits), and `wait`.
- **Touches:** `tap`, `double-tap`, `hold`, `swipe`, `drag`, `pinch`, `type`, `key`, and `scroll-to`. `tap`, `double-tap`, `hold`, and `pinch` aim at a point in dp, or at an element by its text, label, or id. Each touch but `scroll-to` can then wait for a text or a still screen.
- **The device:** `devices`, `open-url`, `rotate`, `theme`, `background`, `foreground`, and `dismiss`. `dismiss` closes a system sheet, a dialog, the keyboard, or an overlay of your app.
- **The probe:** when your app renders `<LoupeProbe />` from `@rootnative/loupe-probe`, `insets` and the rules use the app's own safe area.

[unreleased]: https://github.com/rootnative/loupe/compare/loupe@0.0.0-alpha.1...HEAD
[0.0.0-alpha.1]: https://github.com/rootnative/loupe/releases/tag/loupe@0.0.0-alpha.1
