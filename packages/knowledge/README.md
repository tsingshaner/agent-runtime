# Project Knowledge

`Knowledge.open(dataDir)` opens persistent project-to-directory bindings without
starting a runtime. Mutations acquire a disk lock and reload bindings; competing
instances fail with RESOURCE_BUSY instead of overwriting state. After a crash,
inspect and remove a stale bindings.json.lock before retrying. Use
`bind(projectId, directory)` to select an existing local directory;
`binding(projectId)` returns its canonical location and `unbind(projectId)` only
removes the binding, never the documents.

`list`, `read`, `create`, `edit`, `delete`, and `search` all take the project ID.
Document paths are relative `.md` paths; parent directories must already exist.
Symlinks within a binding are rejected for operations and omitted from listings.
Creates refuse existing destinations, edits require existing regular files, and
writes use a flushed temporary file and atomic replacement. Search returns at
most 20 literal case-insensitive matches by default (maximum 100), with excerpts;
read returns the complete current document. No per-run content snapshot is kept.

The binding is a resource selection, not an OS sandbox against an external
process concurrently renaming directories. Run this service against directories
whose structure is controlled by the application owner.
