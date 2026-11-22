# @rootnative/loupe

Layout checks for iOS and Android, built for AI agents.

loupe drives an emulator or a device, opens each screen of your app, and
gives your agent exact numbers: element frames, safe areas, cutouts, and
edges, in dp. Your agent can then say "pass" or "fail" with evidence, not
with a guess from a screenshot.

> loupe is in alpha, and it drives Android only for now. A new version can
> change the commands, their options, and their JSON.

## What you need

- Node.js 20.19 or later.
- `adb` from the Android SDK platform tools, on your `PATH` or in
  `$ANDROID_HOME/platform-tools`.
- An emulator or a device with Android 11 (API level 30) or later.

## Use it with an agent

### The MCP server

`loupe mcp` serves each loupe command as an MCP tool, over stdin and stdout.

In Claude Code:

```sh
claude mcp add loupe -- npx -y @rootnative/loupe mcp
```

In VS Code, add it to `.vscode/mcp.json`:

```json
{
  "servers": {
    "loupe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rootnative/loupe", "mcp"]
    }
  }
}
```

In another MCP client:

```json
{
  "mcpServers": {
    "loupe": {
      "command": "npx",
      "args": ["-y", "@rootnative/loupe", "mcp"]
    }
  }
}
```

When adb isn't on your `PATH`, set `ANDROID_HOME` in the server's `env`.
With more than one device, set `ANDROID_SERIAL`, or let the agent give
`device` in each call.

The server runs one call at a time, because two touches at the same time
lose events. A sweep sends its progress, and a cancelled call stops at a
safe point. `screenshot` and `sweep` also give their images in the result.

### The skill

`skills/loupe/SKILL.md` tells your agent how to use loupe: the workflow, the
rules, and what to do for each error. It also tells the agent to ask you
before it starts an emulator or opens an app.

A client with the MCP skills extension gets the skill from the server. For
another agent, copy the skill into the agent's skills folder. For Claude
Code:

```sh
npm install --save-dev @rootnative/loupe
cp -R node_modules/@rootnative/loupe/skills/loupe .claude/skills/
```

## Use it from the command line

```sh
npx @rootnative/loupe devices
npx @rootnative/loupe open-url "exp://127.0.0.1:8081/--/settings" --app host.exp.exponent --wait-still
npx @rootnative/loupe check --app host.exp.exponent
npx @rootnative/loupe rotate landscape-left
npx @rootnative/loupe check --app host.exp.exponent
```

Run `loupe --help` for the commands, and `loupe <command> --help` for the
options of one command.

To check many screens in one call:

```sh
npx @rootnative/loupe sweep \
  --url "exp://127.0.0.1:8081/--/settings" \
  --url "exp://127.0.0.1:8081/--/profile" \
  --orientation portrait,landscape-left \
  --theme light,dark \
  --app host.exp.exponent
```

A sweep writes `loupe-sweep/report.json`, a screenshot of each screen, and a
contact sheet of each variant. A red frame on the contact sheet marks a
screen that failed. At the end, loupe puts the orientation and the theme
back.

## The output

- Each position and size is in dp, from the top-left corner of the current
  orientation. Each reading gives `scale`, the pixels in one dp.
- Through a pipe, each command prints JSON: `{ "ok": true, "command": …,
  "data": … }`, or `"ok": false` with `"error": { "code": …, "message": …
  }`. In a terminal, it prints text. `--json` and `--no-json` choose.
- Exit codes: 0 passed, 1 failed (also a check that ran and found a
  defect), 2 a wrong command or option, 130 cancelled.

## The rules

`check` and `sweep` run these rules:

| Rule | Fails when |
| --- | --- |
| `inset` | An element with text, a label, or a touch sits under a system bar or the cutout, or outside the safe area. |
| `overflow` | An element at a screen edge is shorter than the elements like it in its row or column: the edge cuts it. |
| `centred` | A text with an element on each side is more than 4 dp from the centre of its container. |
| `touch-target` | An element that you can press is smaller than 48 × 48 dp. From 40 dp, loupe gives a warning: a `hitSlop` can make it whole. |
| `mirrored` | In RTL, an element sits where LTR puts it. Save the other direction with `ui --out <file>`, then run `check --mirror-of <file>`. |

Each finding gives the element and its numbers in dp.

## The commands

| Command | What it does |
| --- | --- |
| `devices` | List the Android emulators and devices, and the AVDs that don't run. |
| `open-url` | Open a link (a deep link or a web page), and wait until it opens. |
| `check` | Check the screen for layout defects with the rules above. |
| `sweep` | Open each link in each orientation and theme, check each screen, and write a report, the screenshots, and a contact sheet of each variant. |
| `screenshot` | Save the screen as a PNG file, upright in each orientation. |
| `ui` | Read the accessibility tree of the screen, with frames in dp. |
| `insets` | Read the safe-area insets and the cutout of the current orientation. |
| `measure` | Measure the colour runs along a row or a column, or where an element sits on the screen and in the safe area. |
| `wait` | Wait until the screen keeps still, or until an element is on the screen. |
| `rotate` | Turn the screen, and wait until it has turned. |
| `theme` | Set the system theme to light or dark, and wait until the app shows it. With no theme, read it. |
| `tap` | Tap one point, or the element with a text, label, or id. |
| `double-tap` | Tap one point or element twice. |
| `hold` | Touch one point or element and hold it: a long press. |
| `swipe` | Move one touch in a straight line from one point to another. |
| `drag` | Touch, hold, move, hold, and lift, with a screenshot while the touch is down. |
| `pinch` | Pinch or spread two fingers around a point or an element, and turn them. On an emulator only. |
| `scroll-to` | Scroll until the element with a text, label, or id is in view, and give its frame. |
| `type` | Type text into the field that has the focus. |
| `key` | Press one key, for example `back`, `home`, or `enter`. |
| `dismiss` | Close the top layer over the app: the keyboard, a dialog, a menu or a sheet of the app, a system sheet, or the notification shade. |
| `background` | Send the app in front to the background. With `--for`, bring it back after that time. |
| `foreground` | Bring an app back to the front, as a person does from Recents. |
| `version` | Print the loupe version and the host it runs on. |

## The probe

With [`@rootnative/loupe-probe`](https://github.com/rootnative/loupe/tree/main/packages/probe#readme)
in your app, `insets` and the rules use the app's own safe area. Without it,
loupe takes the safe area from Android.

## Privacy

- On a real phone, give `--app`. loupe then reads the screen only while that
  app is in front, so it never shows another app to your agent.
- loupe makes no network call. It talks to the device through adb only.

## License

MIT
