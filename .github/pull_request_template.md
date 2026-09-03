## Summary

-

## Validation

-

## Release

Pull requests are squash-merged, and the pull request title becomes the squash
commit title. It must follow Conventional Commits so release-please can decide
the changelog entry and version bump.

Use the plugin scope when the change affects Herdr Supervisor as a plugin:

- `feat(plugin): ...` for plugin features
- `fix(plugin): ...` for plugin fixes
- `docs(plugin): ...` for plugin documentation
- `feat(plugin)!: ...` for breaking plugin changes
