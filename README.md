# Scout

Watches any site you point it at and messages you on Telegram when something matching turns
up. Used cars on StandVirtual and OLX today, a specific bag or a flight tomorrow — adding a
site is a config action, never a code change.

Everything runs locally. The model is your own Ollama on your own GPU; nothing about what
you're shopping for leaves the machine.

## How it works

```
fetch ──▶ extract ──▶ filter ──▶ diff vs store ──▶ judge ──▶ notify
 http      recipe      price/     fingerprints      local
 └▶browser (no LLM)    year/km    only              model
   on block
```

The ordering is the design. Two properties fall out of it:

- **Inference cost scales with what's new, not with search size.** A 200-listing target
  still judges the two listings that appeared since last time.
- **The model cannot invent a notification.** Identity is decided before it runs, from a
  hash of the canonical URL — so a model that phrases a title differently between runs can
  change how a listing is *described*, never whether it is *new*.

### Targets and recipes

Two files per search, both committed, owned by different parties:

| | `targets/<id>.yaml` | `recipes/<id>.recipe.yaml` |
|---|---|---|
| Says | **what** you want | **how** to read the page |
| Written by | you | the model |
| Changes when | you change your mind | the site redesigns |

That split is what makes `git diff recipes/` meaningful: a change there means the site
moved, and the diff shows which field mapping shifted.

## Setup

```bash
cp .env.example .env          # add your bot token + chat id
scripts/bake-model.sh          # bakes `scout` from qwen3.8:27b
yarn scout doctor              # confirms ollama, model, vision
```

Then add a search:

```bash
yarn scout generate <target-id>      # model writes the recipe from the live page
yarn scout run <target-id> --no-llm  # verify extraction, no GPU load
yarn scout poll <target-id>          # full pipeline incl. scoring
```

Or from Telegram: `/add`, paste a URL, describe what you want in plain words. It generates
the recipe, previews what it found, and only saves once you've confirmed it looks right —
a saved target whose recipe doesn't work is worse than none, because its only symptom is
silence.

## Running it

```bash
docker compose up -d --build   # from the HOST, not the dev container
docker compose logs -f scraper
```

## Two-tier network model

```
┌─ dev container ─────────────┐   ┌─ scraper service ────────────┐
│ creds: ~/.claude ~/.npmrc   │   │ NO credentials mounted       │
│ EGRESS: strict allowlist    │   │ EGRESS: open                 │
│  + hosts from targets/*.yaml│   │ read-only rootfs, cap_drop   │
└─────────────────────────────┘   └──────────────────────────────┘
```

The scraper gets the open internet precisely *because* it holds nothing worth stealing. The
dev container keeps its allowlist because it holds everything. The docker socket is never
mounted into the dev container — that would be equivalent to host root.

Adding a target widens the dev allowlist by exactly one hostname, on the next container
start or `sudo /usr/local/bin/init-firewall.sh`.

See [infra/devcontainer/](infra/devcontainer/) — the config is versioned here, not only in
the centralized template, because being unable to reach it from inside the container is
exactly when you need to fix it.

## Commands

| | |
|---|---|
| `yarn scout list` | targets and their state |
| `yarn scout doctor` | ollama, model, vision availability |
| `yarn scout fetch <url>` | what came back, and how much it condensed |
| `yarn scout generate <id>` | write the recipe from the live page |
| `yarn scout run <id> [--no-llm]` | extract and filter; stateless |
| `yarn scout poll <id> [--no-llm]` | full pipeline; writes the db |

`--no-llm` skips every model call. Useful for debugging extraction without loading weights
onto a GPU something else is using.

Telegram: `/list` `/status` `/run` `/pause` `/resume` `/add` `/remove`, plus per-listing
**Mute seller** · **Hide** · **Save**.

## Notes from building it

Things that were not obvious and cost real time:

- **`"14.500 €"` is fourteen thousand five hundred.** Through `parseFloat` it's `14.5`,
  which sails under a `price.max: 15000` filter and notifies you about every car on the
  site. See [coerce.ts](src/extract/coerce.ts).
- **urql serializes its cache as a JSON *string*.** On StandVirtual every listing lives
  inside a 175KB string in `__NEXT_DATA__`. No path expression reaches through a string —
  hence `unwrap` in the recipe format.
- **Condensing has to unwrap that too.** Clipping the string to 120 chars let the model see
  enough to infer the path but no field names, so it invented plausible ones and extracted
  silent nulls.
- **Key/value arrays can't be sampled.** `parameters` is `[{key:'origin'},{key:'make'},…]`
  with `mileage` past position 6; two exemplars hid that the key existed.
- **Thinking mode cost 3× for no benefit on the judge** — 14.9s vs 5.0s for the same
  verdict. Scoring against stated criteria is classification, not deduction.

## Terms of service

Automated scraping is generally contrary to OLX's and StandVirtual's terms. At
personal-monitoring scale, with the per-host rate limiting, jitter and `robots.txt`
handling here, this is commonplace and low-risk — but the decision to run it is yours.
`RESPECT_ROBOTS=false` exists so that ignoring robots.txt is always an explicit choice.
