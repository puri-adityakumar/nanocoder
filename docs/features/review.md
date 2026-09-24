# Grounded Review

`/review` investigates a branch or pull-request diff with read-only tools and
reports only findings that survive deterministic citation checks and an
independent verification pass.

## Usage

```text
/review
/review feature-branch
/review 42
/review quick
/review quick feature-branch
```

With no target, Nanocoder reviews the current branch against the default
branch. A numeric target is treated as a GitHub pull request and requires the
`gh` CLI.

| Command | Behavior |
| --- | --- |
| `/review [target]` | Grounded finder, citation gate, and independent verifier |
| `/review quick [target]` | Original one-shot model review from the diff |

## Verification pipeline

1. A finder investigates the diff and surrounding code using `git_diff`,
   `git_log`, `read_file`, `search_file_contents`, and
   `lsp_get_diagnostics`.
2. Nanocoder rejects citations whose file or line does not exist or is not in
   or near a changed hunk.
3. A fresh verifier investigates each surviving finding without receiving the
   finder's conversation.
4. A finding is reported only when the verifier returns `CONFIRM` with
   confidence of at least 80.

Finder and verifier runs have enforced tool-call and turn budgets. The final
report includes dropped findings and reasons so rejected or unverifiable claims
do not disappear silently.

## Safety and limits

- Review agents receive only the five read-only tools listed above. The
  executor enforces that ceiling even if a custom agent definition requests
  additional tools.
- At most ten candidate findings are verified per review.
- Large grounded-review diffs are visibly truncated to the first and last 2,000
  lines. `/review quick` retains its existing 1,000-line policy.
- Project or user definitions named `review-finder` and `review-verifier`
  override the built-in prompts, but the runtime tool ceiling and budgets still
  apply.
- `nanocoder review` currently launches the interactive UI and therefore still
  requires a TTY.
