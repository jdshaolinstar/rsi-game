# Patchwork: the game that fixes itself

A playable dungeon game that ships with bugs, and a coding agent built on the Meta Model API that keeps making it better while people play. Every change has to prove itself on held-out work before it ships, and the agent keeps track of its own failures.

Built for the AIE Code Summit hackathon, Nov 7, 2026. Problem statement: **The System That Gets Better.**

- Play: `/` (scan the QR, drag to move, you shoot automatically)
- Control room: `/control`

## How it works

There are three loops, and each one adopts a change only when an independent check confirms it.

**1. The game gets better.** Players' crashes, deaths, quit points and written feedback stream to the server. Scripted bot players also playtest every version in a sandbox. The Fixer (`muse-wonder-1.0`) reads those signals and writes a small patch toward the chosen goal: fewer crashes, more players reaching the boss, beating the boss, or longer sessions. Each patch then goes through these steps:

1. It must apply cleanly and use no banned APIs.
2. It must raise the goal score on **held-out bot seeds** it never saw.
3. It must pass **guardrails** against cheating the goal. Deleting a room to "improve progress" fails because content was removed and the boss was reached too fast.
4. It ships as a **canary** to a share of real players, and is rolled back if real players crash more.
5. Only then is it promoted to everyone. Every version is kept with its parent, diff, reason and evidence.

**2. The agent gets better.** Every rejected or rolled-back patch is logged as a failure. The Reflector reads the failures and proposes one new general rule for the Fixer's **skillbook**, which becomes a new skillbook version. The new version is scored against the current one on a **held-out bug bench**: seeded bugs the Reflector never sees, checked by hidden tests that also catch workarounds. One example is raising a tuning value to hide a code bug. A skillbook version is adopted only if it solves more held-out bugs. Otherwise it is discarded.

**3. It looks better (Meta vision).** `muse-image-1.0` generated the target art. Each look step, `muse-spark-1.3-contributor` compares a screenshot of the game with the target and proposes a new theme. A vision judge then compares the old and new screenshots **twice, with the order swapped**. The new look is adopted only if it wins both times, so a position bias can't win it.

Bug hunters earn points when their crash reports and feedback reach the agent, and more when a fix ships.

## Meta models used

| Model | Job |
|---|---|
| `muse-wonder-1.0` | Fixer and Reflector: writes patches and skillbook rules |
| `muse-spark-1.3-contributor` | Vision: proposes themes and judges which screenshot is closer to the target |
| `muse-image-1.0` | Generated the target art |

## Run it

```bash
echo "MODEL_API_KEY=your-meta-key" > .env
node server.mjs            # http://localhost:8080, control room at /control
node scripts/benchcheck.mjs  # checks that every seeded bug fails and the clean game passes
```

Node 20 or newer. No dependencies. Set `ADMIN_TOKEN` to protect the control actions when hosted, and open `/control?admin=TOKEN`.

## Layout

| Path | What |
|---|---|
| `versions/v1/game.js` | The original game with its bugs. Pure logic (`create`, `step`) is separate from drawing, so the same file runs in browsers and in the sandbox |
| `agent/playtest.mjs` | Sandboxed bot playtests (Node `vm`, no API key, time limit). The agent can't edit it |
| `agent/bench.mjs` | The bug bench: 4 training bugs and 6 held-out bugs with hidden checks |
| `agent/evolve.mjs` | The loops: Fixer, gates, canary, rollback, Reflector, skillbook versions, vision look loop |
| `server.mjs` | Serves the game, routes players to stable or canary, collects telemetry, runs playbooks |
| `public/` | Player page, control room, target art |

## Built during the hackathon

Everything in this repository was written on Nov 7, 2026, during the event, with Claude Code. That includes the game, the playtest harness, the bug bench, the agent loops, the server and both pages. The target art was generated with `muse-image-1.0` during the event. No code or assets from other projects.

## Honest limits

- The bot players are scripted, not people. They are labeled as simulated throughout.
- The held-out bug bench is small: 6 tasks. With `muse-wonder-1.0` the base agent already solves most of them, so skillbook proposals are often discarded. That is the gate working, but the room for improvement there is small.
- Canary decisions with few real players are weak evidence. The control room shows how many real sessions each decision used.
