# Interchange

A cross-repo map of what you shipped, in what order, and what each thing holds up.

Git draws a graph per repo. When one feature lands across web, backend and
mobile in the same run, no single graph shows it — so you draw it yourself, on
paper, in one pass, to remember later what you built on top of what.

Paper handles that right up to the point where it doesn't. It drifts out of
sync with the repos. It points forward when the question you actually ask is
backward: *what breaks if I pull this out?* And nothing on it can be un-drawn,
so a reverted feature looks exactly like a live one six months later.

Interchange is that sketch as a committed file, drawn as a transit map — repos
are lines, features are stations, a merge is an interchange — with one thing
paper cannot do: it reads your repos and tells you what shipped without being
drawn.

```
interchange init      # start a map here
interchange serve     # draw on it in a browser
interchange check     # compare it against the repos
```

Not on npm yet, so install it from this repo (see **Installing**, below).

## The map file

One file, `interchange.json`, committed next to the code. There is no database
and no second place to keep the truth.

```json
{
  "version": 1,
  "repos": [
    { "id": "web", "remote": "acme/web" },
    { "id": "be", "remote": "acme/backend" },
    { "id": "kyc", "label": "secure-kyc", "remote": "acme/secure-kyc", "branch": "release" }
  ],
  "features": [
    {
      "id": "routes",
      "name": "Payment routes",
      "status": "live",
      "prs": [{ "repo": "web", "number": 214 }, { "repo": "be", "number": 661 }],
      "exposes": "`POST /routes` returns `providerId` and `settlementDelay`.",
      "chose": "One shared route table over per-provider tables."
    },
    {
      "id": "users",
      "name": "Users tab",
      "status": "live",
      "deps": ["routes"],
      "prs": ["web#231", "be#690"]
    }
  ]
}
```

Array order is ship order, top to bottom. A feature sits on every line it
touched — derived from its pull requests, so most rows never need `repos` at
all.

| field | what it is |
| --- | --- |
| `id` | stable handle other features point at |
| `name` | what you'd call it out loud |
| `status` | `planned`, `flight`, `live` or `reverted` |
| `deps` | feature ids this one sits on |
| `prs` | `{"repo","number"}` or the short form `"web#214"` |
| `merge` | draw it as an interchange, not a station |
| `repos` | lines it touched that no pull request reveals |
| `assumes` | what it takes as given from below |
| `exposes` | what the layers above can rely on |
| `chose` | the call you made, and what you gave up |

`assumes`, `exposes` and `chose` are all optional. An empty one shows on the
map as a visible gap rather than blocking a save — see *On the writing*, below.

Backticks in those fields render as code. Everything else is escaped.

There is a JSON Schema at `schema/interchange.schema.json`. Point `$schema` at
it and your editor gets completion and the field descriptions inline;
Interchange preserves the key when it writes.

## Tracking decisions

`chose` is one line on one feature. It cannot say a call was later overturned,
and it cannot say a call made at the base layer is what broke something three
layers up. That is what `decisions` is for.

```json
"decisions": [
  {
    "id": "fixed-settlement-delay",
    "chose": "Treat settlementDelay as a fixed number per provider",
    "over": "reading it from the provider on every call",
    "cost": "Async providers have no fixed delay, and nothing above knows that.",
    "feature": "routes",
    "affects": ["pending", "payout"],
    "brokeAt": "payout"
  }
]
```

A decision names where it was made (`feature`), what rests on it holding
(`affects`), and — the part no per-feature field can express — where it stopped
holding (`brokeAt`).

Status is **derived, never stored**, so a record cannot contradict itself:
`brokeAt` makes it broken, `supersededBy` makes it superseded, otherwise it
stands.

```
interchange decide "Poll for pending actions" --at pending --over push   --cost "Needs replacing at volume"
interchange broke fixed-settlement-delay --at payout
interchange decisions --standing
```

Two things fall out of this that the sketch could not do:

- A feature inherits every decision made beneath it, whether or not anyone
  listed it under `affects`. Open a feature and you see the calls it is
  standing on.
- When a decision breaks, anything still resting on it is flagged.
  `interchange validate` on the example says:

  ```
  check Decision "fixed-settlement-delay" broke at payout, but pending still rests on it.
  ```

  That is the payout revert traced back to the base layer, as data rather than
  a line of prose.

## What the map answers

**What breaks if I pull this out.** Open any feature and everything sitting on
it, transitively, turns red. That is the question you actually ask, and the one
a forward-pointing sketch cannot answer.

**What is dead.** Solid is live, dashed is in flight, struck through with a
slash across the station is reverted. Six months on, the dead branches still
look dead.

**What you meant versus what shipped.** Draw a feature before you build it and
it sits there faintly. When it lands, the line fills in.

**What is only one repo's problem.** Tap a coloured line and everything that
line never touched drops back.

## The drift check

`interchange check` reads every repo with a `remote` set and compares it
against the map:

```
Interchange - /work/interchange.json

The map against the repos
  web/main  not on the map
            web#301 merged 2 Sept with no row on this map.
            probably sits on: pending
  be#722    map is ahead
            "Application pending actions" is drawn as live, but a pull request is still open.
```

It reports four things:

- **not on the map** — merged, never drawn. Proposed as a row you accept or
  reject; the guess at what it sits on is the last thing drawn in that repo.
- **map is ahead** — drawn as live, but the work is still open.
- **map is behind** — drawn as planned or in flight, but all of it merged.
- **abandoned work** — a referenced pull request was closed without merging.

It never edits the map on its own. A map that rewrites itself is a map you stop
reading. In the browser each finding gets *Add to map* or *Not a feature*;
rejecting one records it under `ignore` so it is never raised again.

Two rules keep the check honest. It only judges pull requests it actually
fetched — silence is never read as evidence. And it only says "all of it
merged" when the window covered all of it; a partial view stays quiet.

In CI, `--fail-on error` exits non-zero when something shipped without a row.
See `examples/drift-check.yml`.

## For agents

The map is meant to be read and written by whatever is shipping, which is
increasingly not a person. See `AGENTS.md` — drop it in your repo and an agent
has the whole protocol.

Before changing something:

```
interchange context pending
```

That prints what the feature sits on, what rests on it, the assumptions it
inherits from below, and the standing decisions it must not break. `--json` for
a parseable form. With no feature id, the whole map compact enough for a
context window.

After shipping:

```
interchange add "Offline queue" --prs rn#78 --deps pending
interchange set e2e --status live --add-pr admin#95
interchange decide "Poll over push" --at pending --cost "Needs replacing at volume"
interchange broke fixed-settlement-delay --at payout
```

Every write is validated against the whole map first. **A write that would
introduce an error is refused with exit 1 and the file is left untouched** — so
attempting one is safe, and the error says what was wrong. Errors that were
already in the map do not block unrelated writes.

Every command takes `--json`. Output pipes cleanly.

## Commands

```
interchange serve      --port <n>  --open
interchange check      --json  --fail-on <none|warning|error>  --since <date>
                       --only <repo,repo>  --max-pages <n>  --api-base <url>
interchange context [id]          what to know before changing something
interchange decisions             --standing  --broken
interchange add <name>            --status --repos --deps --prs --after
                                  --assumes --exposes --chose --merge --id
interchange set <id>              --status --name --assumes --exposes --chose
                                  --add-pr --add-dep
interchange decide <text>         --over --because --cost --at --affects
                                  --supersedes --id
interchange broke <id> --at <feature>
interchange validate
interchange init       --force
interchange --help
```

`--map <path>` works on all of them; without it, Interchange walks up from the
current directory looking for `interchange.json`, the way git finds a repo.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) to read private repos and raise the rate
limit. For GitHub Enterprise, `--api-base` or `GITHUB_API_URL`.

`serve` binds to loopback only and rejects requests whose `Host` is not this
machine — it holds your token and writes to your disk, so it does not answer
the network.

## On the writing

`chose` — the call you made and what you gave up — is the field most likely to
get skipped at 11pm mid-run, and the one nothing else depends on. So it is
optional, and an empty one renders as *No decision recorded* rather than
disappearing. The map degrades to a topology diagram plus a working drift
check, which is still worth opening.

A full `decisions` entry asks for more writing again, which is the same trap.
Two things are meant to keep it from becoming homework: `interchange decide`
is one line in a shell, and the payoff is not for you — it is for whoever
touches this next, human or agent, who gets told what they are standing on
without having to ask. Static analysis finds the calls; it will not find that
payout webhooks assumed a fixed `settlementDelay` inherited from the base
layer. A person writes that once, and the map carries it.

## Installing

Interchange is not published to npm. Install it from this repository:

```
npm install -g github:mridulshan/interchange
```

That builds on install and puts `interchange` on your path. Or from a clone,
which is easier if you want to change it:

```
git clone https://github.com/mridulshan/interchange
cd interchange && npm install && npm link
```

Either way, `interchange --help` should now work from any directory.

## Private repos

`init`, `serve` and `validate` never touch the network. `init` reads
`git remote get-url origin` locally and writes the file — a private repo needs
no token and no access at all:

```
cd ~/work/your-private-repo
interchange init
```

It records the remote's *default* branch, not whatever you have checked out,
and omits `branch` entirely when it cannot tell — the map reader then assumes
`main`.

Only `check` reaches GitHub. Give it a token with read access to **every** repo
the map draws a line for:

```
GITHUB_TOKEN=ghp_... interchange check
```

A fine-grained personal access token needs *Contents: read* and *Pull requests:
read* on each of them. If the token cannot see one, that line is skipped with
the reason printed and the rest of the check still runs — it never silently
reports a repo as clean because it could not read it.

In GitHub Actions the built-in `GITHUB_TOKEN` only covers the repo the workflow
runs in, so a cross-repo map needs a PAT or a GitHub App token in a secret.
See `examples/drift-check.yml`.

## Try it

```
git clone https://github.com/mridulshan/interchange
cd interchange && npm install && npm run build
node dist/cli.js serve --map examples/payments.json
```

The example is the sketch this was built from: five repos, one merge that gates
everything above it, and one revert that traces back to an assumption in the
base layer. It points at repos that do not exist, so `check` will report every
line as unreadable — that is the skip path doing its job.

## Development

```
npm test          # 117 tests: graph, decisions, context, map format,
                  # reconciliation, writes, server, client, git
npm run typecheck
npm run dev       # rebuild on change
```

The core (`src/core`) is pure and runs in both node and the browser — the same
`applyFinding` that the CLI would use is what the *Add to map* button calls.
