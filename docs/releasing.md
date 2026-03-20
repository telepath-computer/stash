# Releasing

## How releases work

Pushing to `main` triggers the publish workflow (`.github/workflows/publish.yml`), which:

1. Compares the version in `package.json` to the previous commit's version.
2. If they are the same (or the previous version is missing), auto-bumps the patch version.
3. If they differ, uses the version already in `package.json` as-is.
4. Publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC from GitHub Actions — no npm token secret).
5. Commits the final version back to `main` as a `[skip ci]` bump commit.

The workflow still needs a **`PAT` repository secret** so checkout and the post-publish `git push` can run (e.g. past branch protection).

In practice: bump the version manually before pushing if you want a minor or major release; otherwise CI will cut a patch release automatically.

For commits that should not trigger a publish at all (license, docs, CI config, metadata), add `[skip ci]` to the commit message.

**Important:** CI compares the top commit to the one immediately before it (`HEAD~1`). If the version bump commit is not the last commit pushed — for example, because other commits were added on top of it before pushing — CI will see the same version in both `HEAD` and `HEAD~1` and auto-bump. To avoid an unintended patch bump, **make sure the version bump commit is the last commit on the branch before pushing to main.**

## Release checklist

1. **Run the full test suite** locally first — unit, integration, e2e, and VM:

   ```bash
   npm run test:all   # unit + integration + e2e
   npm run test:vm    # full suite on Linux VM including systemd
   ```

2. **Bump the version** if this is a minor or major release. This must be the last commit before pushing:

   ```bash
   npm version 0.3.0 --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "bump version to 0.3.0"
   ```

   Skip this step for patch releases — CI will auto-bump.

3. **Push to main:**

   ```bash
   git push origin <branch>:main
   ```

   If the remote has diverged (e.g. a CI version bump commit), merge it first:

   ```bash
   git fetch origin
   git merge origin/main --no-edit
   # resolve any package.json conflict in your favour, then:
   git push origin <branch>:main
   ```

4. **Verify** the publish workflow completes in GitHub Actions and the new version appears on npm.

## Version policy

- **Patch** (`0.x.y → 0.x.y+1`): bug fixes, internal refactors, test or doc updates with no user-visible behavior change. Let CI auto-bump.
- **Minor** (`0.x → 0.x+1`): new user-facing commands or flags, new exported API surface, meaningful behavior changes. Bump manually.
- **Major** (`x → x+1`): breaking changes to the public API or CLI contracts. Bump manually and document breaking changes.
