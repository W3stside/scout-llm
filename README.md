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

Or from Telegram: `/add` and describe what you want in plain words — no URL needed. Scout
works out which site to search, previews what it found, and only saves once you confirm.
Pasting a URL still works and skips discovery.

```bash
# From the HOST — discovery fetches arbitrary model-proposed URLs, so it runs in the
# credential-free scraper tier, never the dev container (see "Two-tier network model").
docker compose run --rm scraper node dist/cli.js discover "BMW estate, diesel, under 15k, 2015+, near Porto"
```

### How discovery avoids guessing

A model's memory of *which sites exist* is reliable. Its memory of any given site's **URL
schema** is not — asked for BMWs on olx.pt it proposes `/autos/bmw`, which is plausible and
404s; the real path is `/carros-motos-e-barcos/carros/bmw`. Retrying does not help, because
each retry is another guess from the same faulty memory.

So discovery runs in two phases and verifies the result:

1. **Which site** — from memory, where memory is trustworthy.
2. **Which URL** — the site's homepage is fetched and its real published paths harvested,
   so the model *chooses* a path instead of inventing one.
3. **Did it work** — the results are checked against your stated numbers.

Step 3 exists because of one nasty property of these sites: an unrecognised query parameter
is **not an error**. `?price_max=15000` on a site expecting `search[filter_float_price:to]`
returns HTTP 200, a full page, and every listing at any price. Extraction succeeds, the
recipe is fine, and the search is worthless. The only reliable signal is the results
themselves — if you asked for under 15,000 and a third are above it, that parameter was
ignored:

```
price cap:   41/41 (100%) — applied
year from:   39/41  (95%) — applied
mileage cap: 12/38  (32%) — NOT applied
```

A failure like that is fed back as a specific fault to correct, not a vague retry. And
because the numbers were parsed once up front, they also populate the target's
deterministic filters — so your limits are enforced even where the site's own search
ignored them.

## Running it

```bash
docker compose up -d --build   # from the HOST, not the dev container
docker compose logs -f scraper
```

## Two-tier network model

```
┌─ dev container ─────────────┐   ┌─ scraper service ────────────┐
│ creds: ~/.claude ~/.npmrc   │   │ NO credentials mounted       │
│ EGRESS: strict allowlist    │   │ EGRESS: open, OUTWARD only   │
│  + hosts from targets/*.yaml│   │ read-only rootfs, cap_drop   │
└─────────────────────────────┘   │ ollama via 3-endpoint proxy  │
                                  └──────────────────────────────┘
```

The scraper gets the open internet precisely *because* it holds nothing worth stealing. The
dev container keeps its allowlist because it holds everything. The docker socket is never
mounted into the dev container — that would be equivalent to host root.

Open egress is open *outward* only. The scraper holds no route to the host: Ollama is
reached through `ollama-proxy`, an nginx that forwards exactly the three API endpoints
Scout calls, and a connect-time guard in the app ([guard.ts](src/fetch/guard.ts)) refuses
any fetch — page, image, redirect hop, or model-proposed URL — that lands on a private,
loopback, link-local or otherwise non-public address. That guard runs at socket-connect
time against the *resolved* address, which is what closes DNS rebinding and
redirect-to-127.0.0.1, not just naive URL filtering.

Anything that fetches URLs an attacker can influence belongs in the scraper tier. That
includes `discover`, which fetches whatever the model proposes after reading a (hostile)
homepage — run it via `docker compose run`, not `yarn scout discover` in the dev container.

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
| `yarn scout check-telegram` | verify token + chat id, send a test message |
| `docker compose run --rm scraper node dist/cli.js discover "<desc>"` | find a search URL from plain English, showing every attempt (scraper tier — it fetches arbitrary URLs) |
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
