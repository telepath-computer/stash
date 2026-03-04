# Setup should prompt to replace existing values

## Why

`stash setup github` silently does nothing when a token already exists. The `collectFields` function skips any field that already has a value in `current`, so re-running setup to replace a bad token just prints "Configured github." without ever prompting. The user has no indication that nothing changed, and no way to replace the token without manually editing `~/.stash/config.json` (or `$XDG_CONFIG_HOME/stash/config.json`).

This was hit in practice: a user needed to swap from a fine-grained PAT to a classic token. They ran `stash setup github`, saw "Configured github.", and assumed it worked.

## Behavior

When `stash setup` encounters a field that already has a value and no CLI flag was provided, it prompts the user with the existing value masked:

```
Personal access token [current: ghp_****a3f2]:
```

- If the user enters a new value, it replaces the old one.
- If the user presses Enter with no input, the existing value is kept.

For secret fields, show only the last 4 characters. For non-secret fields, show the full current value.

The `--field value` CLI flags still override without prompting (unchanged).

`stash connect` is not affected — it calls `collectFields` for setup fields with existing values, so the same fix applies when connect prompts for missing setup. But connect fields (e.g. `repo`) are per-stash and written fresh each time, so they don't hit this issue in practice.

## Targets

### `code/src/cli.ts`

Update `collectFields`:

1. When `values[field.name]` already has a value and `valuesFromCli[field.name]` is not set, prompt instead of skipping.
2. For the prompt message, show the masked current value: `"Personal access token [current: ****a3f2]: "` for secrets, `"Repository (user/repo) [current: user/repo]: "` for non-secrets.
3. If the user enters empty input, keep the existing value. Otherwise replace it.

The `password` prompt from `@inquirer/prompts` returns empty string for empty input, so the check is `if (newValue) values[field.name] = newValue`.

### `spec/cli.md`

Update the `stash setup` section to note that existing values are shown (masked for secrets) and can be replaced or kept by pressing Enter.

## Tests

### Unit tests

```
1. collectFields: prompts to replace existing secret field
   - current = { token: "ghp_abc123" }
   - Simulate user entering "ghp_new456"
   - Result: { token: "ghp_new456" }

2. collectFields: keeps existing value on empty input
   - current = { token: "ghp_abc123" }
   - Simulate user pressing Enter (empty string)
   - Result: { token: "ghp_abc123" }

3. collectFields: CLI flag overrides without prompting (existing behavior)
   - current = { token: "ghp_abc123" }, valuesFromCli = { token: "ghp_flag789" }
   - No prompt shown
   - Result: { token: "ghp_flag789" }

4. collectFields: prompt message masks secret field
   - current = { token: "ghp_abc123" }, field has secret: true
   - Prompt message contains "****c123" (last 4 chars)

5. collectFields: prompt message shows full value for non-secret field
   - current = { repo: "user/repo" }, field has secret: false
   - Prompt message contains "current: user/repo"
```
