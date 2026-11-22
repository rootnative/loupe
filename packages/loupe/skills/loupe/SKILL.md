---
name: loupe
description: Check the layout of a mobile app on an Android emulator or device with the loupe tools, and get numbers in dp, not guesses from a screenshot. Use it when you check or fix how a screen looks in portrait or landscape, light or dark, LTR or RTL, near the system bars, the cutout, or the screen edges.
---

# loupe

loupe drives an Android emulator or device and measures each screen of your
app. It gives you exact numbers: element frames, safe areas, cutouts, and
edges. Use them to say "pass" or "fail" with evidence.

Each loupe tool gives JSON. Each input field has a description in the tool's
schema, so this skill doesn't repeat them. loupe works on Android 11
(API level 30) and later.

## Ask the user first

- Ask before you start an emulator. Don't start one on your own.
- Ask before you open an app or a link on a device, unless the user asked
  for that run.
- On a real phone, give `app` in each call. loupe then reads the screen
  only while that app is in front, so it never shows you another app.
- Don't change a setting that the user didn't ask for. `rotate` and
  `theme` change the device. Put back what you changed. `sweep` puts the
  orientation and the theme back itself.

## Before the first check

1. Run `devices`. Only a device in the state `ready` takes commands.
2. When two or more devices are ready, give `device` (the serial or the
   AVD name) in each call.
3. Give `app` in each call that reads or touches the screen. For Expo Go,
   it's `host.exp.exponent`.
4. Run one loupe call at a time on a device. Two touches at the same time
   lose events. The MCP server already runs its calls one after the other.

## Units

- Each position and size is in dp, from the top-left corner of the
  current orientation.
- Each reading gives `scale`: the pixels in one dp.
- Each screenshot is upright, in each orientation.

## Check one screen

1. Open the screen with `open-url` and its deep link. Give `waitText` (a
   text on that screen) or `waitStill`, so the call ends when the screen is
   there.
2. Run `check`. Read `passed`, then the findings of each rule that failed.
3. Run `rotate` with `landscape-left`, then `check` again.
4. Run `rotate` with `landscape-right`, then `check` again. A cutout on one
   side shows only in one of the two landscapes.
5. Run `rotate` with `portrait` to put the device back.

Take a `screenshot` when you want to see the screen, but decide with
`check`. Over MCP, the result of `screenshot` also holds the image. Give
`scale` (for example 0.5) or `crop` to make it smaller.

## Check many screens: sweep

Give `sweep` one `url` for each screen. Add `orientation`
(`portrait,landscape-left`) and `theme` (`light,dark`) to check each
screen in each of them. Add `scroll` to check each screen again after one
scroll down.

- The result lists each screen that failed, with each finding and its
  numbers. You don't need to check those screens again.
- A sweep writes to `out` (`loupe-sweep` by default): `report.json`, a
  screenshot of each screen, and a contact sheet of each variant. A red
  frame on the contact sheet marks a screen that failed. Over MCP, the
  result also holds each contact sheet as an image.
- A screen that loupe can't open or check gets its error in the report,
  and the sweep goes on.
- A sweep can take minutes. Over MCP, it sends its progress after each
  screen. When you cancel it, it stops before the next screen and puts
  the orientation and the theme back. It then writes no report.

## The rules

`check` runs each rule by default. Give `rules` (a comma list) to run
fewer.

| Rule | Fails when | What to look at |
|---|---|---|
| `inset` | An element with text, a label, or a touch sits under a system bar or the cutout, or outside the safe area. | The edge in the finding. In landscape, the left and the right insets can differ. A full-screen scrim doesn't count. |
| `overflow` | An element at a screen edge is shorter than the elements like it in its row or column: the edge cuts it. | The row or the column of the element. Let it wrap or scroll, or make its items smaller. |
| `centred` | A text with an element on each side is more than 4 dp from the centre of its container. | Centre the text in the whole bar, not in the space between the side items. Name a text with `centred`, `centredLabel`, or `centredId` to check it. |
| `touch-target` | An element that you can press is smaller than 48 × 48 dp. | From 40 dp, loupe gives a warning, not a finding: the tree doesn't show `hitSlop`. Look in the code for a `hitSlop` that makes it 48 dp. |
| `mirrored` | In RTL, an element sits where LTR puts it. | It runs only with `mirrorOf` (see below). |

To check `mirrored`:

1. Show the screen in LTR. Run `ui` with `out` set to a file.
2. Show the same screen in RTL, in the same orientation.
3. Run `check` with `mirrorOf` set to that file.

## Read a result

- `passed` is false when a rule failed. A failed check is still a
  success: the data has each finding. The CLI exits with 1 for it.
- Each finding has the `element`, a `message`, and `details` in dp.
- `safeAreaSource` says where the safe area came from: `probe` (the app's
  own numbers) or `dumpsys` (the system's numbers).
- A `warnings` line says where loupe isn't sure. Read it before you decide.
- After a fix, reload the app and check the same screen again, in the same
  orientation.

## The probe

`@rootnative/loupe-probe` gives loupe the app's own safe area, layout
direction, colour scheme, and route. Render `<LoupeProbe route={path} />`
once, inside your `SafeAreaProvider`. It renders nothing in a release
build. Without it, loupe takes the safe area from Android.

## Errors

A failed call has an error `code` and a `message`. The message says what
to do. The codes:

| Code | What to do |
|---|---|
| `no_device` | Ask the user to start an emulator or to connect a phone. |
| `device_ambiguous` | Run `devices`, then give `device`. |
| `device_unavailable` | The device is offline, not authorized, or still booting. Wait, or ask the user. |
| `tool_missing` | loupe can't find adb. Ask the user to set `ANDROID_HOME`. |
| `tool_failed` | adb failed. Read the message. |
| `app_not_in_front` | Another app or a dialog is in front. Run `dismiss` for a dialog or a sheet, or `foreground` for the app. |
| `not_idle` | The screen didn't keep still long enough to read it. Run `wait` with `still`, then try again. |
| `element_not_found` | Run `ui`, find the element, and give its exact text, label, or id. |
| `element_ambiguous` | More than one element matches. Give its `id`. |
| `orientation_locked` | The app sets its own orientation. Check the orientations it allows. |
| `timeout` | The screen didn't get there in time. The message says whether the action ran. |
| `no_handler` | No app on the device opens that link. |
| `invalid_input` | Fix the input. The message names the field. |
| `unsupported` | loupe can't do this on this device or API level. |
| `cancelled` | The call was cancelled. loupe stopped at a safe point. |

## The CLI

The CLI has the same commands: run `loupe <command> --help`. A field such
as `waitText` is the flag `--wait-text`. When you read the output through a
pipe, it's JSON: `{ "ok": true, "command": …, "data": … }`, or `"ok": false`
with `"error": { "code": …, "message": … }`. Exit codes: 0 passed, 1
failed, 2 a wrong command or flag, 130 cancelled.

## Don't

- Don't decide pass or fail from a screenshot when a rule gives numbers.
- Don't run two loupe calls at the same time on one device.
- Don't leave the device turned or in another theme.
