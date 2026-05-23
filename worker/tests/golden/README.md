# Golden-set compliance evals (P2.9 / #347)

Labeled fixtures that gate every change to the compliance ruleset or engine in
CI. The harness (`../test_compliance_golden.py`) loads each `cases/*.json`
fixture, runs it through `services.compliance_engine.evaluate`, and asserts the
recorded expectation. **A rule edit that breaks a golden case fails CI.**

## What each case asserts

Every fixture is a JSON object:

```json
{
  "name": "human-readable case name",
  "description": "why this case exists / what it gates",
  "context": { ... },              // the evaluate() context
  "llm_candidates": [ ... ] | null,// operator-supplied LLM candidates (optional)
  "expect": {
    "overall_verdict": "pass" | "fail" | "needs_review",
    "rule_verdicts": {             // optional per-rule assertions
      "meta.personal_attributes": "fail"
    }
  }
}
```

## The required cases (issue #347 acceptance criteria)

- **`personal_attributes_old_hook.json`** — the P0.5 donor line
  "Are you embarrassed by your bathroom?" MUST FAIL `meta.personal_attributes`.
- **`personal_attributes_fixed_hook.json`** — the benefit-framed replacement
  "Ready for a bathroom you'll love?" MUST PASS.
- **`ftc_guarantee_no_disclosure.json`** — a guarantee claim without the
  disclosure MUST FAIL FTC.
- **`roofing_before_after.json`** — a roofing before/after MUST PASS (property,
  not health/cosmetic).

## Adding a case

Drop a new `cases/<name>.json` file. The harness discovers it automatically.
Keep one assertion-intent per file so a CI failure points at one rule.
