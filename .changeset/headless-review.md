---
"@nanocollective/nanocoder": patch
---

`nanocoder review` runs without a terminal when stdout is piped, redirected, or the process is in CI. The report is markdown on stdout, or JSON with `--output-format json`; progress stays on stderr. `quick` and `deep` select the same tiers as `/review`. Part of #1287.
