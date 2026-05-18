# Release

FlowCell publishes to npm as `flow-cell` using npm trusted publishing from GitHub Actions.

## One-time npm setup

Configure npm trusted publishing for this package:

```sh
npm trust github flow-cell --repo ubugeeei/flow-cell --file release.yml --env npm-publish
```

For maximum safety after trusted publishing is confirmed, configure the package on npmjs.com to require 2FA and disallow traditional token publishing.

## Publish

1. Update `package.json` version.
2. Commit and push to `main`.
3. Create and publish a GitHub Release tagged `v<version>`, for example `v0.1.0`.

The release workflow verifies the tag matches `package.json`, builds a tarball without OIDC permission, and publishes that tarball from a separate OIDC-enabled job.
