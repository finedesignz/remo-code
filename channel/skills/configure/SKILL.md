---
name: hub:configure
description: Configure the Remo Code hub connection for this channel
arguments:
  - name: hub_url
    description: The hub URL (e.g., https://remo-code.com or http://localhost:3040)
    required: true
  - name: token
    description: The session token (starts with remo_)
    required: true
---

# /hub:configure

Save the hub URL and session token so the channel plugin can connect.

## Steps

1. Create the config directory at `~/.claude/channels/hub/` if it doesn't exist
2. Write the `.env` file with `HUB_URL` and `HUB_TOKEN`
3. Set file permissions to owner-only (chmod 600)
4. Tell the user to restart Claude Code with `--channels` to activate

## Template

Write this to `~/.claude/channels/hub/.env`:

```
HUB_URL={{hub_url}}
HUB_TOKEN={{token}}
SESSION_ID={{default to basename of current working directory}}
```

After writing, set permissions:
```bash
chmod 600 ~/.claude/channels/hub/.env
```

Then tell the user:
> Configuration saved. Restart Claude Code with the channel enabled:
> ```
> claude --dangerously-load-development-channels server:hub
> ```
