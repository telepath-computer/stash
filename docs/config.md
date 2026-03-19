# Config And Metadata

Stash keeps a small set of user-facing config files plus a few local metadata files.

## Global Config

Global config lives at:

- `~/.stash/config.json`
- or `$XDG_CONFIG_HOME/stash/config.json`

It stores:

- provider setup such as GitHub tokens
- background stash registration

Example:

```json
{
  "providers": {
    "github": { "token": "ghp_..." }
  },
  "background": {
    "stashes": ["/Users/me/notes"]
  }
}
```

## Per-Stash Config

Per-stash config lives at `.stash/config.json` inside the synced directory.

Older prerelease stashes that still use `.stash/config.local.json` are migrated automatically to `.stash/config.json` when stash starts. If both the old and new paths exist at the same time, stash stops and asks for manual cleanup rather than guessing.

It stores:

- provider connection settings for this stash
- per-stash safety and behavior flags

Example:

```json
{
  "allow-git": true,
  "connections": {
    "github": { "repo": "user/repo" }
  }
}
```

Allowed per-stash keys today:

- `allow-git`

## Key Convention

User-facing config files use kebab-case for multi-word keys. Existing single-word keys such as `connections`, `providers`, `background`, and `stashes` stay lowercase.

Internal metadata files are not part of the user-facing config contract and may use different key naming where convenient.

## `.stash/` Metadata

Local metadata inside `.stash/`:

```text
.stash/
  config.json
  snapshot.json
  snapshot/
  status.json
  sync.log
  sync.lock
```

- `config.json` stores per-stash user-facing config
- `snapshot.json` stores the last synchronized hash state and is the only `.stash/` file pushed to the remote
- `snapshot/` stores text merge bases for future three-way merges
- `status.json` stores the latest background daemon result
- `sync.log` stores capped per-stash background sync logs
- `sync.lock` exists only while a sync is active

Everything in `.stash/` is local-only except `snapshot.json`.

Older prerelease stashes that still use `.stash/snapshot.local/` are migrated automatically to `.stash/snapshot/` on startup with the same conflict rule: if both layouts exist, stash throws and requires manual cleanup.
