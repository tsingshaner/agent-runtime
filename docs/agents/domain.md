# Domain docs

## Layout

Use single-context across this repository, including all packages:

- `CONTEXT.md`: shared domain vocabulary and model.
- `docs/adr/`: architecture decision records.

## Before exploring

Read root `CONTEXT.md` and ADRs relevant to the work.

If these files do not exist, proceed silently. Do not require
or scaffold them upfront. The domain-modeling skill creates
them when terminology or decisions are resolved.

## Vocabulary

Use the terms defined in `CONTEXT.md` consistently in code,
tests, issues, and proposals. Record genuine vocabulary gaps
for domain-modeling.

## Decision conflicts

Explicitly identify any proposal that contradicts an existing
ADR, cite the ADR, and explain why reconsideration is warranted.
