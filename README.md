# loupe

Layout checks for iOS and Android, built for AI agents.

loupe drives an emulator or a device, opens each screen of your app, and
gives your agent exact numbers: element frames, safe areas, cutouts, and
edges, in dp. Your agent can then say "pass" or "fail" with evidence, not
with a guess from a screenshot.

> loupe is in alpha, and it drives Android only for now. On an iOS simulator,
> only `devices` and `screenshot` work. A new version can change the
> commands, their options, and their JSON.

## The packages

| Package | What it is |
| --- | --- |
| [`@rootnative/loupe`](packages/loupe#readme) | The CLI, the MCP server, and the skill for your agent. |
| [`@rootnative/loupe-probe`](packages/probe#readme) | A tiny helper in your app. It gives loupe the app's own safe area, in development only. |

## Start

Add the MCP server to your agent. In Claude Code:

```sh
claude mcp add loupe -- npx -y @rootnative/loupe mcp
```

Then ask your agent to check your screens, for example: "Sweep the settings
and the profile screens of my app in portrait and landscape, and tell me
each layout failure." The [package README](packages/loupe#readme) has the
setup for other clients, the skill, the CLI, and each command.

loupe needs Node.js 20.19 or later, `adb` from the Android SDK platform
tools, and an emulator or a device with Android 11 (API level 30) or later.

## What loupe finds

- An element under a system bar or the cutout, or outside the safe area.
- An element that a screen edge cuts.
- A title off the centre of its bar.
- An element too small to touch.
- In RTL, an element on the side where LTR puts it.

Each finding gives the element and its numbers in dp.

## Development

The repository is a pnpm workspace. Use the Node.js version in `.nvmrc`.

```sh
pnpm install
pnpm test
pnpm build
```

CI also runs the built CLI and the MCP server on Android emulators with API
levels 30 and 36.

## License

MIT
