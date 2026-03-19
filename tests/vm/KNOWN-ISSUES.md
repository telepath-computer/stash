# Known VM/Service Issues

## systemd service can't find `node` when installed via nvm

**Status:** Reproduced on Ubuntu 24.04 VM with nvm + Node 22.

**Symptom:** `stash start` succeeds but the service crash-loops with exit code 127:

```
/usr/bin/env: 'node': No such file or directory
```

systemd logs show:
```
Main process exited, code=exited, status=127/n/a
stash-background.service: Failed with result 'exit-code'.
```

**Root cause:** The `stash` binary has a `#!/usr/bin/env node` shebang. The generated systemd unit correctly resolves the full path to the `stash` binary (e.g. `/root/.nvm/versions/node/v22.22.1/bin/stash`), but systemd doesn't load shell profiles (`.bashrc`, `.nvm/nvm.sh`), so `env` can't find `node` on PATH. This affects any non-system Node.js installation (nvm, fnm, volta, etc.).

Generated unit file at time of failure:
```ini
[Unit]
Description=Stash background sync

[Service]
Type=simple
ExecStart=/root/.nvm/versions/node/v22.22.1/bin/stash daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Required fix in `@rupertsworld/daemon`:** `renderUnit()` must emit `Environment=PATH=...` so the service inherits the PATH that was active at install time. The plist renderer already handles this correctly for macOS via `EnvironmentVariables`.

**Workaround:** Symlink node into a system path:

```bash
sudo ln -s $(which node) /usr/local/bin/node
```
