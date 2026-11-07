# skill_002

- created: 2026-11-07T23:23:35.048Z
- project: Patchwork Dungeon (browser game, ES5 JavaScript)
- status: confirmed
- context: learned from 4 failure(s): T1; T2; T3

## Skill

Do not stop at the reported symptom: trace and test the complete end-to-end path from initial state to the intended final outcome, auditing every step the fix depends on and every step it makes newly reachable for latent root causes — such as state used before initialization, conditions made unreachable by constraints imposed elsewhere, and computations that inconsistently deviate from their configured values. Fix each blocker at its source and submit only after a full end-to-end run completes s

## Why

Each patch was locally correct but left other blockers on the same progression path, so end-to-end checks still failed; in one case removing an early blocker exposed a later crash. A full-path audit and completion test would have revealed and fixed those hidden failures before submitting.
