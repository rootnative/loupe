# @rootnative/loupe

Layout checks for iOS and Android, built for AI agents.

loupe drives a simulator or an emulator, opens each screen of your app, and
gives your agent exact numbers: element frames, safe areas, cutouts, and
edges, in pt and dp.

> loupe is in early development. It has no release yet.

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

## Requirements

Node.js 20.19 or later.

## License

MIT
