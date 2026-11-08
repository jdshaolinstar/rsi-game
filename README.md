# Patchwork: the game that improves itself

A playable dungeon game that ships with bugs, and a coding agent built on the Meta Model API that keeps making it better while people play. Players' crashes and feedback, plus goals the creator types in plain words, go into one inbox. The agent releases new versions you can pick and compare. Every change has to prove itself on held-out work before it ships. The agent also writes its own skills from its failures, and keeps a skill only if held-out bugs confirm it.

Built for the AIE Code Summit hackathon, Nov 7, 2026. Problem statement: **The System That Gets Better.**

## Live demo

| | URL | Who it's for |
|---|---|---|
| **Play the game** | http://patchwork-demo.us-east-1.elasticbeanstalk.com | Anyone. Drag to move, you shoot automatically. Crashes and feedback go straight to the agent. Pick any version from the dropdown, or share one with `/?v=vN` |
| **Control room** | http://patchwork-demo.us-east-1.elasticbeanstalk.com/control | Anyone can **watch**: the live agent feed, the inbox, every version with its diff and the context the agent saw, the skill manifests, the vision target, saved states and the bug-hunter board |

The agent controls in the control room (Improve now, Teach itself, Look step, New game, goals, schedule, playbooks, save and load) are **locked to an admin token**, because every action spends Meta API credits. Judges can ask the team for the token. Without it, those buttons are refused by the server. The server also stops after a fixed number of model calls (`CALL_CAP`).

The live server starts from a saved system state. To see the whole history, open the game's version dropdown: v1 is the buggy first draft, v2 is the agent's crash fix, v3 is the new look from "too grey" feedback, v4 is a new game built without learned skills (the baseline), and v5 is the same brief built with them.

## What you can do

- **Play any version.** Each version is a self-contained folder (`versions/vN/game.js`, `theme.json`, `meta.json`). The player page has a version picker and a "what changed" panel listing the fixed reports and the goals it optimized for.
- **Report and suggest.** Crashes are caught automatically. Thumbs up or down and written feedback go into a persistent inbox. Each item is routed by Muse Spark to the code Fixer (gameplay, bugs, difficulty) or the vision loop ("not cute enough"), and tracked from open to in test to shipped.
- **Set goals in plain words.** "Players should play longer" is mapped by Muse Spark to measurable signals (session time, reaching the boss, wins, coins, no crashes). Goals stack, and each version records what it optimized for.
- **Choose the update schedule:** manually, after every N play sessions, after every N feedback items, every N minutes, or continuously.
- **Share a version.** The share button links to `/?v=vN`. Shares are counted per version as a real-player signal; bots can't share, so shares never gate a code change.
- **NEW GAME FROM RSI.** Describe a game, or let Muse Spark suggest one players will share. The agent builds it twice in parallel: WITH the confirmed skills, the best and most-shared version, shipped feedback and goals, and WITHOUT any of that. Both run the same held-out bot playtests. The with-skills game ships if it's playable, the baseline stays playable for comparison, and the A/B is recorded on the version.
- **Save and load system states.** A state is a checkpoint of the whole system: every version's code and look, plus the inbox, goals, skill manifests, failures, log and player stats. States are stored in S3 and pulled back at boot, so they survive redeploys. `snapshots/demo-v5.json` is the live run from the event.
- **Choose the Fixer budget:** Fast (about 10 s per rewrite, the default), Normal or Deep.

## How it works

There are three loops, and each one adopts a change only when an independent check confirms it.

**1. The game gets better.** Players' crashes, deaths, quit points and written feedback stream to the server. Scripted bot players also playtest every version in a sandbox. The Fixer (`muse-wonder-1.0`) reads those signals and writes a small patch toward the chosen goal: fewer crashes, more players reaching the boss, beating the boss, or longer sessions. Each patch then goes through these steps:

1. It must apply cleanly and use no banned APIs.
2. On **held-out bot seeds** it never saw, it must raise the goal score, or address player requests without lowering it.
3. It must pass **guardrails** against cheating the goal. Deleting a room to "improve progress" fails because content was removed and the boss was reached too fast.
4. It ships as a **canary** to a share of real players, and is rolled back if real players crash more.
5. Only then is it promoted to everyone. Every version is kept with its parent, diff, reason and evidence.

**2. The agent gets better.** Every rejected or rolled-back patch is logged as a failure. The Reflector reads the failures and writes one new general skill, saved as `skills/skill_NNN.md` with its date, project and context. That skill plus the confirmed ones form a candidate `skills/skill_manifest_vN.md`. The new version is scored against the current one on a **held-out bug bench**: seeded bugs the Reflector never sees, checked by hidden tests that also catch workarounds. One example is raising a tuning value to hide a code bug. A manifest is adopted only if it solves more held-out bugs. Otherwise the skill is marked discarded. Nothing is deleted, so the folder shows what the agent tried and what was confirmed. See [skills/README.md](skills/README.md).

**3. It looks better (Meta vision).** `muse-image-1.0` generated the target art. Each look step, `muse-spark-1.3-contributor` compares two frames of the game with the target, plus any look requests from players, and proposes a new theme. A vision judge then compares the old and new screenshots **twice, with the order swapped**. The new look is adopted only if it wins both times, so a position bias can't win it.

Bug hunters earn points when their crash reports and feedback reach the agent, and more when a fix ships.

## Meta models used

| Model | Job |
|---|---|
| `muse-wonder-1.0` | Fixer and Reflector: writes patches and skillbook rules |
| `muse-spark-1.3-contributor` | Vision (proposes themes, judges screenshots), feedback routing, goal mapping |
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
| `agent/evolve.mjs` | The loops: inbox and routing, goals, schedule, Fixer, gates, canary, rollback, Reflector, skill manifests, vision look loop |
| `skills/` | The agent's versioned skills and manifests, written by the agent |
| `server.mjs` | Serves the game, routes players to stable or canary, collects telemetry, runs playbooks |
| `public/` | Player page, control room, target art |
| `agent/store.mjs` | Durable state storage in S3 (upload on save, pull at boot) |
| `snapshots/` | Saved system states committed to the repo |

## Built during the hackathon

Everything in this repository was written on Nov 7, 2026, during the event, with Claude Code. That includes the game, the playtest harness, the bug bench, the agent loops, the server and both pages. The target art was generated with `muse-image-1.0` during the event. No code or assets from other projects.

## Honest limits

- The bot players are scripted, not people. They are labeled as simulated throughout.
- The held-out bug bench is small: 6 tasks. In the logged run ([skills/RUN-LOG.md](skills/RUN-LOG.md)), manifest v1 fixed 0/6 and manifest v2, with the agent-written `skill_002`, fixed 6/6. That's one run on one small bench, not a general benchmark. An earlier run discarded the same kind of skill when model calls timed out.
- NEW GAME FROM RSI's with-vs-without comparison is a single run each time, and the baseline call sometimes times out. When it does, the log says there was no fair comparison.
- Canary decisions with few real players are weak evidence. The control room shows how many real sessions each decision used.
