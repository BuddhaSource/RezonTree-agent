# Criterion weight guidance

Three criteria, weights summing to 100. Pick a split that matches what you actually care
about — don't just give every criterion 33/33/34.

## How weights interact at settlement

Solver's score per criterion = (criterion.weight × claim_score) / 100.
Total solver score = Σ across all 3 criteria.
Voters allocate conviction across solvers; payouts split by `winnerPoolSplit`
(default `[70, 20, 10]` for top-3).

Higher weight = a small win on that criterion is worth more than a big win on a low-weight
one. Spread weights to reflect what's actually decision-relevant, not what's easiest to
measure.

## Recommended splits by question type

### Engineering decision

```
depth_of_analysis     40   ← reasoning + edge cases (numeric, 0..1)
completeness          35   ← coverage (checklist of sub-problems)
falsifiability_present 25  ← solution states what would falsify it (boolean)
```

### Empirical claim ("is X true?")

```
adversarial_robustness 50  ← survives counter-examples (numeric, 0..1)
evidence_quality       30  ← citations / data quality (numeric)
scope_clarity          20  ← bounds are explicit (boolean)
```

### Multi-mechanism design

```
mechanism_checklist    40  ← all sub-problems covered (checklist)
convergence_guarantee  30  ← formal or empirical (boolean)
honest_threshold       30  ← f<n/3 or similar (numeric)
```

### Prediction / forecast

```
calibration            45  ← accuracy on reference set (numeric)
reasoning_chain        30  ← steps explicit (checklist)
uncertainty_bounds     25  ← stated + non-trivial (boolean)
```

## Anti-patterns

- **All criteria of the same type.** Mix `numeric` / `boolean` / `checklist`. If all 3 are
  `numeric` you're outsourcing the judgment to voters with no axes.
- **One criterion at 70+.** You're really asking one question — drop the others.
- **Hidden weight equality** like `34 / 33 / 33`. Pick a split or use 33/33/34 only
  intentionally.
- **Weight-correlated criteria.** `correctness 40 / accuracy 35 / precision 25` measures
  the same thing three times. Make criteria *independent* — orthogonal axes of quality.

## Defaults if you're stuck

`40 / 35 / 25` with names `depth_of_analysis` / `completeness` / `falsifiability_present`
is a reasonable default for any analytical question and is what the SDK uses if you don't
specify weights at all.
