---
"@nanocollective/nanocoder": patch
---

`nanocoder review` runs without a terminal when stdout is piped, redirected, or the process is in CI. The report is markdown on stdout, or JSON with `--output-format json`; progress stays on stderr. Like `nanocoder run`, it refuses a directory you have not trusted unless you pass `--trust-directory` or set `NANOCODER_TRUST_DIRECTORY=1`. `quick` and `deep` select the same tiers as `/review`. Part of #1287.
