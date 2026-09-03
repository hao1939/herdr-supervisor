## Summary

-

## Validation

-

## Release

PR titles must follow Conventional Commits because release-please uses the
squash commit to decide the changelog entry and version bump.

Use the plugin scope when the change affects Herdr Supervisor as a plugin:

- `feat(plugin): ...` for plugin features
- `fix(plugin): ...` for plugin fixes
- `docs(plugin): ...` for plugin documentation
- `feat(plugin)!: ...` for breaking plugin changes
