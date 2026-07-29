# The Robot Opponent & Solo Play

How single-player works in Pocket Artillery, and why the robot is built the way
it is.

---

## The core decision: the robot lives on the server

A robot opponent could have been a few hundred lines of client-side JavaScript
driving the local `GameEngine`. It isn't, for one reason: **the game is already
server-authoritative, and a client-side robot would need a second, parallel set
of rules.** Turn order, ammo accounting, damage falloff, terrain destruction, and
win detection all live in the SpacetimeDB module. Reimplementing them in the
browser to move an AI tank would mean two implementations of the same game that
have to agree forever.

So the robot is seated **inside the module** as an ordinary `Player` row:

```
player table
├── <human identity>   is_robot = false   slot 0
└── <robot identity>   is_robot = true    slot 1   robot_difficulty = "hard"
```

Everything downstream falls out of that:

| Concern | How the robot gets it |
| :------ | :-------------------- |
| Turn order | It occupies a slot. `next_living_slot` picks it like anyone else. |
| Legal moves | Its shot goes through `launch_shot` — the same function `fire_weapon` calls. |
| Ammo | Its row has the same three ammo columns, decremented by the same code. |
| Physics & damage | `sim::simulate_projectile` / `sim::blast_damage`, unchanged. |
| Client updates | It writes to the same public tables, so subscribers get the same row changes and the client turns them into the same events. |
| Win/lose | `process_impact` counts living players; it doesn't know or care which are robots. |

The client needed no new event types for the robot — a robot's shell arrives as
the same `SERVER_PROJECTILE_SPAWNED` / `SERVER_IMPACT` pair a human's does.

### Robot identity

`Player` is keyed by `Identity`, and a robot has no client to authenticate. Each
room mints a **deterministic synthetic identity** from its room code
(`robot_identity_for`), tagged with a fixed 8-byte prefix. Deterministic so
reconnects keep talking about the same tank; prefixed so it can never collide
with a real JWT-derived identity.

---

## Turn execution

Turns are handed off in exactly one place. `begin_turn` — which every path funnels
through (match start, impact resolution, timeout pass, resume-after-pause) —
checks whether the newly-active slot belongs to a living robot, and if so arms a
scheduled reducer:

```
begin_turn ──► turn_timer   (+30s, the human-facing turn clock — a backstop here)
           └─► robot_timer  (+800ms, PHASE_AIM)
                    │
                    ├── plan the shot, write angle/power/weapon to the robot's row
                    └─► robot_timer (+900ms, PHASE_FIRE)
                             └── launch_shot(...) with the aim it committed
```

Two phases rather than one, for a reason that is purely about feel: the client
sees the robot's barrel swing to its chosen aim, holds, *then* fires. A
single-phase robot hits you out of nowhere.

Because the aim is written to the row in phase 1 and read back in phase 2, the
shot that goes out is exactly the one the player watched being lined up.

### Every scheduled step re-validates

A scheduled reducer can fire after the world has moved on. Both phases bail out
unless *all* of these still hold:

- the room still exists
- `status == "playing"` (not paused by a disconnect, not finished)
- `room.turn_id == timer.turn_id` — the turn generation counter, so a timer armed
  for an earlier turn is a no-op
- no projectile is already in flight
- the active slot holds a living robot

Combined with `scheduler_only` (which rejects any client that tries to call a
scheduled reducer — they aren't even exposed in the generated bindings), a robot
turn cannot be replayed, forced, or land in a stale world.

---

## Decision making

`robot.rs` is pure: `plan_shot(&Battlefield, Difficulty, seed) -> Option<ShotPlan>`.
No table access, no scheduler, no randomness beyond the seed it is handed.

### Aim search

The robot does not solve the ballistics analytically, and it does not cheat. It
**searches candidate shots through `sim::simulate_projectile`** — the very same
simulator that resolves the shell for real:

1. Restrict the angle window to the half that actually points at the target
   (`cos(angle)` sets the horizontal direction, so a leftward target needs an
   obtuse angle). This halves the space and prevents nonsense shots.
2. Coarse sweep: 5° × 5 power steps (~300 simulated shots).
3. Refinement passes around the winner, per difficulty.

Each candidate scores as the distance from its predicted impact to the target's
hull, plus:

- **+5000 if the blast would also catch the robot.** Landing a hit is worthless
  if it goes up with the target.
- **+ 0.02 × power** as a tie-break, so equally accurate solutions prefer the
  gentler lob.

### Skill levels

Difficulty is *not* implemented by giving the robot worse information — it finds
a good solution and then fumbles it by a bounded, seeded amount:

| Skill | Refinement | Aim error |
| :---- | :--------- | :-------- |
| Easy | none (coarse grid only) | ±8° / ±14 power |
| Normal | ±4 window at step 1 | ±3° / ±5 power |
| Hard | plus a ±1 window at step 0.25 | ±0.8° / ±1.2 power |

One guard on top: if the fumble would turn a clean solution into a shot that
lands on the robot's own hull, it fires the clean solution instead. Sloppy is
fine; self-destructive is a bug.

### Weapon policy

Deterministic and stateless:

- Standard shells by default.
- The nuke only when it can *finish* the job (target HP ≤ 55, its full damage) —
  spending it earlier wastes the single round.
- If the preferred weapon's best aim is self-destructive, drop to a smaller
  blast and search again.
- Easy hoards its specials entirely until the standard shells run out.
- Out of everything → no plan → the turn passes rather than stalling.

### Determinism

The seed is `terrain_seed ^ (turn_id × constant)`, so a given turn always
produces the same "mistake". That makes the robot reproducible, its unit tests
stable, and a desync diagnosable.

---

## Solo match lifecycle

```
client                                    module
──────                                    ──────
createSoloMatch(code, name, id, level) ─►  ensure_room(solo = true)
                                           seat_caller()          ── human, slot 0
                                           ensure_robot(level)    ── robot, slot 1
                                           settle_lobby()         ── 2 seated → start_match()
                                                                     └─ begin_turn() → human first
```

`join_match` and `create_solo_match` share `ensure_room` / `seat_caller` /
`settle_lobby`, so a solo match and a multiplayer match reach `"playing"` through
identical code. `create_solo_match` is idempotent: calling it again (a reconnect,
a retry) re-seats the caller, skips the already-seated robot, and resumes a paused
match instead of starting a second one.

**Solo rooms are private.** `join_match` refuses a room with `solo = true` unless
the caller is already seated in it, and `create_solo_match` refuses a room that
isn't solo — so neither mode can hijack the other's room code.

### Edge cases and safeguards

| Situation | Behaviour |
| :-------- | :-------- |
| Human closes the tab | Match pauses, 60s reconnect window, then the robot wins by forfeit. |
| Human reconnects in time | `create_solo_match` re-seats them, `settle_lobby` resumes, and `begin_turn` re-arms the robot timer if it was the robot's turn. |
| Human leaves explicitly | `leave_match` sees only robots remaining and tears the whole room down (robot row included) instead of leaking a room with a lone bot in it. |
| Turn clock expires on the robot | The 30s `turn_timer` is still armed as a backstop; it auto-fires the robot's committed aim. |
| Robot has no ammo | Passes the turn (logged), rather than erroring out and freezing the match. |
| Robot's shot never resolves | Impossible to leave a turn hanging: the impact is scheduled at launch and the turn advances from `process_impact`. |
| Abandoned rooms | A repeating `process_room_cleanup` sweep deletes rooms that have been quiet > 15 min **and** have no connected human, plus any orphaned player/projectile rows. A live match stamps activity every turn (≤ 30s apart), and a host waiting in a lobby is protected by the connected-human check. |

---

## Client side

| Piece | What changed |
| :---- | :----------- |
| `lib/multiplayer/spacetime.js` | Takes `{ solo, difficulty }`; calls `createSoloMatch` instead of `joinMatch`. Surfaces `isRobot` / `robotDifficulty` / `shotsFired` / `solo` in the state it builds, and attaches per-player `damage` to impact events by diffing HP against the previous flush. |
| `lib/game/feed.js` | Pure helpers that turn the event stream into battle-log lines (flagging robot actors) and the end-of-match scoreboard. |
| `lib/engine.js` | Carries the robot flags through `applyServerState`, and paints an **AI** chip above robot tanks on the canvas. |
| `app/page.jsx` | `MODE.PRACTICE` (offline hot seat) / `MODE.SOLO` / `MODE.MULTI`, where the latter two share every network path via `isOnline`. Adds the difficulty picker, AI badges in the HUD/lobby/scoreboard, the battle log, and the match summary. |

The old `'single'` mode was renamed to `MODE.PRACTICE` to keep the offline
sandbox distinct from solo-vs-robot, which is a genuine online match.

---

## Tests

| Suite | What it proves |
| :---- | :------------- |
| `stdb-module/tests-core` (`npm run test:module`) | Ballistics determinism, crater/damage math, and every robot rule: direction, skill ordering (hard out-shoots easy over 24 seeds), ammo respect, nuke policy, wind compensation, never self-splashing when a safe shot exists, always producing a move when it has ammo. |
| `tests/unit` (`npm run test:unit`) | Engine state application and prediction, battle-log wording/tone, scoreboard construction. |
| `tests/integration/solo-flow.ts` | Robot seated automatically, legal robot turns (one shell per turn, correct direction, aim committed before firing), scheduled reducers not client-callable, solo privacy, match completion with a consistent winner, teardown on leave. |
| `tests/integration/multiplayer-regression.ts` | Two-human matches unchanged: seating, turn authority, double-fire rejection, aim replication and clamping, full-room rejection, pause/resume across a real disconnect, room switching. Asserts no robot ever appears in a joined room. |
| `tests/integration/client-events.ts` | The browser's own pipeline: solo connect → match start → robot spawn/impact with damage attribution → match end, no state resync mid-flight, aim on the cheap path, rejected actions surfacing as recoverable errors. |
