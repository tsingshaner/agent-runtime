<!-- cspell:ignore tsingshaner wayfinding wayfinder -->

# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `tsingshaner/agent-runtime`.
Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --body-file <file>`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number>`

Write multiline bodies to a temporary file and pass `--body-file`.
Infer the repository from its Git remote.

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the issue and its comments.

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding

- Track each map in an issue labelled `wayfinder:map`.
- Link child tickets as sub-issues when supported; otherwise use
  a task list in the map and `Part of #<map>` in each child.
- Label children `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Record blockers using native issue dependencies when supported;
  otherwise use `Blocked by: #<number>` in the ticket body.
- Select open, unassigned children whose blockers are all closed.
- Claim a ticket with `gh issue edit <number> --add-assignee @me`.
- On completion, comment with the result, close the ticket,
  and add a summary and link to the map’s decisions.
