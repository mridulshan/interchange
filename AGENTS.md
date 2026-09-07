# Interchange, for agents

This repo carries a map of what shipped across every repo it touches, in what
order, and what each thing holds up. It lives in `interchange.json`.

Read it before you change anything. Update it when you ship.

## Before you change something

```
interchange context <feature-id>
```

That prints, for one feature: what it sits on, what rests on it, the
assumptions it inherits from below, and the standing decisions it must not
break. Standing decisions are the ones nobody has overturned yet — breaking one
silently is the failure this map exists to prevent.

Starting cold, with no feature in mind:

```
interchange context            # the whole map, compact
interchange decisions          # the decision log
```

Add `--json` to any of them for a parseable form.

If your change breaks a standing decision, that is allowed — say so, and record
it (see below). What is not allowed is breaking it without a record, because
the next agent reads this file and not your reasoning.

## After you ship

Every write is validated before it saves. A write that would break the map is
refused with exit code 1 and the file is left untouched, so it is safe to
attempt one and read the error.

```
# a new feature, with the pull requests that carried it
interchange add "Offline queue" --prs rn#78 --deps pending \
  --assumes "Pending actions are safe to replay in any order" \
  --exposes "Local queue that flushes on reconnect"

# something already drawn has landed
interchange set e2e --status live --add-pr admin#95

# a call worth tracking
interchange decide "Polling over push" --at pending \
  --over "Server-sent events" \
  --cost "Needs replacing at volume"

# a call that stopped holding
interchange broke fixed-delay --at payout
```

Ids are derived from the text when you do not pass `--id`. Every command
accepts `--json` and prints what it wrote.

## The rules the map enforces

- A feature must touch at least one line: pass `--prs` or `--repos`.
- `deps` must already be on the map. Add the thing underneath first.
- Array order in `features` is ship order. `add` appends; `--after <id>` places.
- A decision's status is derived, never set: `brokeAt` makes it broken,
  `supersededBy` makes it superseded, otherwise it stands.
- Nothing is auto-drawn from the repos. `interchange check` reports what shipped
  without a row and proposes it; a person or an agent accepts it explicitly.

## Checking your work

```
interchange validate          # structure only, no network
interchange check             # against the real repos, needs GITHUB_TOKEN
```

`check --fail-on error` exits non-zero when something merged without a row.
That is the CI gate; do not work around it by inventing a row for work you did
not do — `interchange check` will propose the right one.

## The file

`interchange.json` is the only source of truth. It has a JSON Schema at
`schema/interchange.schema.json`; point `$schema` at it and the field
descriptions are inline. Key order in the file is fixed, so diffs stay small —
prefer the commands over hand-editing, but hand-editing is fine and the
commands will not fight you.
