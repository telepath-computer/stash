# Migrating to 0.2.0

## Global config format changed

The global config at `~/.stash/config.json` has a new structure. Provider credentials now live under a `providers` key, and there's a new `background` section.

**Old format:**

```json
{
  "github": { "token": "ghp_..." }
}
```

**New format:**

```json
{
  "providers": {
    "github": { "token": "ghp_..." }
  },
  "background": {
    "stashes": []
  }
}
```

**To migrate:** re-run `stash setup github --token <your-token>`. This overwrites the config in the new format. There is no automatic migration — the old format is silently ignored.

## New: background sync

Stashes can now sync continuously in the background via an OS-managed service.

```bash
# one-time: install the background service (macOS/Linux)
stash background install

# register a stash for background syncing
cd ~/my-stash
stash background add

# or register during connect
stash connect github --repo user/repo --background

# check status
stash background status

# remove a stash from background syncing
stash background remove
```

The service uses `launchd` on macOS and `systemd` on Linux. Windows is not yet supported.

## Poll interval changed

`stash watch` and background sync now poll every 10 seconds (was 30 seconds).

## New dependency

`ora` is now a runtime dependency (terminal spinner). Run `npm install` after updating.
