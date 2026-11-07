# Skills: the agent's versioned know-how

The Fixer reads its instructions from the current **skill manifest**. These files are written by the agent itself, in `agent/evolve.mjs`.

- `skill_NNN.md` is one skill: a general lesson about how to diagnose and patch. Each file records when it was created, the project, the failures it was learned from, and its status (`testing`, `confirmed` or `discarded`).
- `skill_manifest_vN.md` is a set of confirmed skills for this kind of work, plus its held-out bug-bench score and its parent manifest.

## How a skill gets in

1. A patch fails: it doesn't apply, a guardrail rejects it, it shows no held-out gain, a canary rolls it back, or it fails a training bug.
2. The Reflector writes one general skill from those failures.
3. A candidate manifest (current skills plus the new one) and the current manifest both try to fix the **held-out** bugs in `agent/bench.mjs`. The Reflector never sees those bugs.
4. The candidate is adopted only if it fixes more of them. Otherwise the skill is marked `discarded` and the manifest stays as it was.

Nothing is deleted, so the history of what the agent tried and what was confirmed stays in this folder.
