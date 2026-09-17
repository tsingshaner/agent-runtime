# Managed Skills

Open `Skills.open(dataDir)`, then `import(sourceDirectory)` to copy a local skill.
SKILL.md must contain YAML metadata with nonempty name and description.
All regular files, including scripts and references, are copied. Symlinks and
special files are rejected. The source is never edited or deleted.

`get(id)` returns metadata and the managed directory, `list()` returns all copies,
and `read(id, relativePath)` reads a current file (defaults to SKILL.md).
`edit(id, path, content)` atomically replaces an existing file after validation.
`bind(projectId, id, enabled)` persists an explicit project selection;
`list(projectId)` includes disabled bindings, while `enabled(projectId)` prepares
only the enabled set. `unbind` removes a project selection; `delete` removes
all bindings and only the managed copy. Reopening retains these decisions.

Mutations reload state under a disk lock; competing instances receive
RESOURCE_BUSY. Inspect stale skills.lock after a crash before removing it.
A failed import may leave an unreferenced copy if the final metadata commit fails;
it is never returned as a successful import. Directory structure must remain
owner-controlled, as with Knowledge; path validation is not an OS sandbox against
concurrent external ancestor replacement.
