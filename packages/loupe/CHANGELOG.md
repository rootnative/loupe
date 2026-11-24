# Changelog

All notable changes to `@rootnative/loupe` are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow modified semver: a breaking change bumps the middle digit (`0.1.0`), and fixes and additions bump the last digit (`0.0.2`).

## [Unreleased]

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
