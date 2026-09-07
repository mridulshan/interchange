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
npx interchange init      # start a map here
npx interchange serve     # draw on it in a browser
npx interchange check     # compare it against the repos
```

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

## Commands

```
interchange serve      --port <n>  --open
interchange check      --json  --fail-on <none|warning|error>  --since <date>
                       --only <repo,repo>  --max-pages <n>  --api-base <url>
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
check, which is still worth opening. When you do write it, that line is the
only place a link like *payout webhooks assumed a fixed `settlementDelay`, and
that assumption came from the base layer* is ever written down. Static analysis
finds the calls; it will not find that.

## Try it

```
npm install && npm run build
node dist/cli.js serve --map examples/payments.json
```

The example is the sketch this was built from: five repos, one merge that gates
everything above it, and one revert that traces back to an assumption in the
base layer.

## Development

```
npm test          # 66 tests: graph, map format, reconciliation, server, client
npm run typecheck
npm run dev       # rebuild on change
```

The core (`src/core`) is pure and runs in both node and the browser — the same
`applyFinding` that the CLI would use is what the *Add to map* button calls.
