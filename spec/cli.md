# CLI

Command-line interface for Stash. Parses commands, handles prompting, and manages global config. Delegates all stash operations to the [Stash class](stash.md).

---

## Commands

### `stash init`

Initializes the current directory as a stash. Delegates to `Stash.init()`.

```
stash init
```

If the directory is already a stash, informs the user and does nothing.

### `stash setup <provider>`

Configures global provider settings (e.g. auth). Provider declares required fields via its static spec. Accepts `--field value` flags or prompts interactively (masked for secret fields).

```
stash setup github --token ghp_...
stash setup github              # prompts for token
```

Writes to [global config](#global-config) under the provider name.

### `stash connect <provider>`

Connects this stash to a provider. Accepts `--field value` flags or prompts interactively. If setup has not been done for this provider, prompts for setup fields too (and writes them to global config).

```
stash connect github --repo user/repo
stash connect github            # prompts for repo (and token if not set up)
```

Delegates to `stash.connect()`. One connection per provider per stash.

### `stash disconnect <provider>`

Removes the connection for the given provider.

```
stash disconnect github
```

Delegates to `stash.disconnect()`.

### `stash sync`

Syncs local files with configured connections. See [stash.md](stash.md) for the sync algorithm.

```
stash sync
```

Subscribes to `mutation` events for live output:

```ts
stash.on("mutation", (mutation) => {
  console.log(`${mutation.path}: disk=${mutation.disk}, remote=${mutation.remote}`)
})
await stash.sync()
```

### `stash status`

Shows configured connections and files changed since last sync.

```
stash status
```

Delegates to `stash.connections` and `stash.status()`.

---

## Global Config

Location: `~/.stash/config.json`. Respects `$XDG_CONFIG_HOME` if set (`$XDG_CONFIG_HOME/stash/config.json`). Directory (`~/.stash/`) allows room for future global state (cache, logs).

Managed by CLI via `readGlobalConfig()` / `writeGlobalConfig()` utility functions. Written by `stash setup <provider>`.

Shape — keyed by provider name, each provider owns its section:

```json
{
  "github": {
    "token": "ghp_..."
  }
}
```

Fields defined by the provider's `ProviderSpec.setup`.

### How CLI instantiates Stash

CLI reads global config and passes it in. Stash never reads global config itself.

```ts
const globalConfig = readGlobalConfig()
const stash = await Stash.load(dir, globalConfig)
```

### CLI flow for `stash setup`

1. Look up provider class from registry
2. Read `ProviderSpec.setup` fields
3. For each field: use `--field value` flag if provided, otherwise prompt interactively (masked if `secret: true`)
4. Write to global config under provider name

### CLI flow for `stash connect`

1. Look up provider class from registry
2. Check global config for setup fields — if missing, prompt for them first (and write to global config)
3. Read `ProviderSpec.connect` fields
4. For each field: use `--field value` flag if provided, otherwise prompt interactively
5. Call `stash.connect(providerName, fields)` — Stash writes to `.stash/config.local.json`

