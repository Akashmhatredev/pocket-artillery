<div align="center">

<img src="./assets/banner.svg" alt="Pocket Artillery" width="100%" />

<h1>🎯 Pocket Artillery</h1>

<p><em>A modern, premium-quality multiplayer artillery battle game — inspired by the classic tank duels of old, rebuilt for the web.</em></p>

<p>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-000000?style=for-the-badge&logo=next.js&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" />
  <img alt="SpacetimeDB" src="https://img.shields.io/badge/SpacetimeDB-Realtime%20DB-6E56CF?style=for-the-badge" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-Module-000000?style=for-the-badge&logo=rust&logoColor=white" />
</p>

<p>
  <a href="#-how-to-play">Play</a> &nbsp;•&nbsp;
  <a href="#-arsenal">Arsenal</a> &nbsp;•&nbsp;
  <a href="#-run-locally">Run Locally</a> &nbsp;•&nbsp;
  <a href="#-architecture">Architecture</a>
</p>

</div>

---

## ⚔️ The Battle

Two tanks. One shifting battlefield. Dial in your **angle** and **power**, read the **wind**, and lob a shell across procedurally-generated, fully **destructible terrain**. Miss and you carve a crater. Hit and you rewrite the landscape — and your opponent's health bar.

**Alpha** `#22d3ee` faces off against **Omega** `#fb7185` in fast, turn-based duels where every shot is validated server-side, so nobody can fudge a trajectory.

```
        ●
     ╱     ╲          ← your arc, bent by the wind
   ╱          ╲
 ▟▛            ╲   💥
▔▔▔▔▔╲___      ▟▛▔▔▔
          ╲___╱      ← terrain you just reshaped
```

---

## 🎮 How to Play

| Step | Action |
| :--: | :----- |
| **1** | Pick your **callsign**, then hit **Vs Robot** for a solo duel — or create a room and share the **room code** with a friend. |
| **2** | On your turn, adjust **Angle** (0–180°) and **Power** (0–100). |
| **3** | Check the **wind** — it nudges your shell mid-flight. |
| **4** | Choose a weapon from your **arsenal** and **FIRE**. |
| **5** | Reduce your opponent from **100 HP** to zero. Last tank standing wins. 🏆 |

---

## 🤖 Solo Play vs the Robot

Hit **Vs Robot** and the backend seats an AI tank opposite you and starts the
match — no second human, no waiting room.

The robot is a **real player**, not a UI trick. It gets a `Player` row in the
same table as you, and its shots run through the exact same reducer path a human
`FIRE` does, so turn order, ammo, physics, damage, and win conditions all apply
to it identically. It cannot see anything you can't: it picks its aim by
searching candidate shots through the same deterministic simulator that later
resolves the shell for real.

Each turn it *thinks* (~0.8s), swings its barrel to the aim it settled on, then
fires (~0.9s later) — so you watch it line the shot up instead of being hit out
of nowhere. Robot tanks are marked with an **AI** badge in the HUD, on the
battlefield, and in the scoreboard, and every decision is logged server-side.

| Skill | Aim error | Behaviour |
| :---- | :-------- | :-------- |
| **Easy** | ±8° / ±14 power | Rough solutions only, and hoards its specials. |
| **Normal** | ±3° / ±5 power | Refines its aim. Saves the nuke for a finishing blow. |
| **Hard** | ±0.8° / ±1.2 power | Near-exact solutions, wind-compensated, punishes mistakes. |

It also plays sensibly: it never lobs a shell onto its own hull, spends the nuke
only when the blast can actually close out the match, and falls back to a smaller
shell when the big one would catch it in the splash.

Solo rooms are **private** — nobody can join your match against the robot.

> Prefer a sandbox? **Practice offline (hot seat)** runs both tanks locally in
> the browser with no backend at all.

📄 Design notes, edge cases, and why the robot lives on the server:
[`ROBOT_OPPONENT.md`](./ROBOT_OPPONENT.md)

---

## 💣 Arsenal

| Weapon | Icon | Blast Radius | Damage | Behavior |
| :----- | :--: | :----------: | :----: | :------- |
| **Standard** | 🎯 | 60 | 25 | The reliable workhorse round. Clean, predictable arcs. |
| **Cluster** | 💥 | 45 | 15 | Splits on impact into a spread of secondary bomblets for wide coverage. |
| **Mini Nuke** | ☠️ | 130 | 55 | Devastating. Massive crater, huge damage, and a signature smoke plume. |

---

## ✨ Features

- 🤖 **AI robot opponent** — three skill levels, seated server-side as a real player that plays by exactly the same rules you do.
- 🌍 **Destructible terrain** — every explosion permanently reshapes the battlefield, and tanks fall when the ground beneath them is blown away.
- 🌬️ **Wind physics** — deterministic ballistic arcs (`vₓt`, `vᵧt − ½gt²`) with per-round wind drift.
- 🎇 **Juicy particle effects** — sparks, debris, and nuke smoke trails rendered in real time.
- 🌐 **Server-authoritative multiplayer** — turns, physics, and damage are all resolved on the backend for cheat-proof matches.
- ⏱️ **30-second turn clock** — run it down and the server fires your current aim for you.
- 🔁 **Reconnect grace window** — drop your connection and rejoin within **60 seconds** without forfeiting.
- 📜 **Battle log + scoreboard** — every shot, hit, and turn handoff is narrated, with an end-of-match summary.
- 📱 **Responsive UI** — a premium dark, neon-accented interface built with Tailwind and Framer Motion.

---

## 🚀 Run Locally

**Prerequisites:** Node.js **20+** (the game uses Next.js 15 / React 19).

### 1. Frontend

```bash
# install dependencies
npm install

# add your Gemini API key
cp .env.example .env.local   # then edit GEMINI_API_KEY

# launch the dev server
npm run dev
```

Open **http://localhost:3001** to enter the war room.

> ⚠️ The app runs on **:3001** because SpacetimeDB's local server uses **:3000** — they'd otherwise collide. `npm run dev` sets this for you.

### 2. Backend (multiplayer)

The real-time layer runs on **SpacetimeDB** — a single Rust/WASM module
(`stdb-module/`) that holds all game state and runs the authoritative physics.
In a second terminal:

```bash
spacetime start                                              # local instance on :3000
spacetime publish -p stdb-module --server local pocket-artillery
npm run stdb:generate                                        # generate TS client bindings
```

Then point the frontend at it via `.env.local`:

```bash
NEXT_PUBLIC_SPACETIMEDB_URI="ws://localhost:3000"
NEXT_PUBLIC_SPACETIMEDB_MODULE="pocket-artillery"
```

> 💡 **Vs Robot** and multiplayer both need the backend (the robot lives there).
> **Practice offline (hot seat)** runs entirely in the browser if you just want
> to lob a few shells.

📄 Full setup + production deploy (Maincloud + Vercel): [`SPACETIMEDB_DEPLOY.md`](./SPACETIMEDB_DEPLOY.md)

---

## 🧪 Tests

```bash
npm test                  # module unit tests (Rust) + client unit tests (node:test)
npm run test:module       # physics + robot AI decision making
npm run test:unit         # render engine, battle log, scoreboard
npm run test:integration  # end-to-end vs a running local SpacetimeDB
```

| Suite | Covers |
| :---- | :----- |
| `stdb-module/tests-core` | Ballistics, terrain, blast damage, and every robot decision rule — run natively via a harness crate, since the module itself only links against the WASM host ABI. |
| `tests/unit` | `lib/engine.js` state application/prediction and the `lib/game/feed.js` battle log + scoreboard. |
| `tests/integration/solo-flow.ts` | Solo match creation, robot seating, legal robot turns, privacy, completion, teardown. |
| `tests/integration/multiplayer-regression.ts` | Two-human seating, turn authority, aim replication, pause/resume, forfeits — the paths the robot work must not disturb. |
| `tests/integration/client-events.ts` | The browser client's own event stream (`MultiplayerConnection` → UI events → feed lines). |

The integration suites talk to a real local instance over a websocket, so start
one first:

```bash
spacetime start
spacetime publish -s local -p stdb-module pocket-artillery --delete-data
npm run test:integration
```

---

## 🏗️ Architecture

Pocket Artillery uses a **server-authoritative, room-based** model — the client renders and predicts, the server decides.

```
┌────────────────┐    WebSocket (subscribe + reducers)   ┌──────────────────────┐
│    Frontend    │ ◀───────────────────────────────────▶ │     SpacetimeDB      │
│ Next.js/React  │        table sync (auto)              │   Rust/WASM module   │
│  canvas engine │        reducer calls (fire/aim)       │ tables + reducers +  │
│ client predict │                                       │ authoritative physics│
└────────────────┘                                       └──────────────────────┘
```

| Layer | Responsibility |
| :---- | :------------- |
| **Frontend** | Rendering, local aiming previews, client-side prediction, audio & particles. |
| **SpacetimeDB** | One WASM module = realtime backend **and** database: turn management, deterministic projectile physics, collision, damage, terrain, the robot opponent, and persistent match state — all in tables + reducers. |

Inside the module:

| File | Responsibility |
| :--- | :------------- |
| `stdb-module/src/lib.rs` | Tables, reducers, scheduling, turn orchestration. |
| `stdb-module/src/sim.rs` | Pure ballistics, terrain generation/destruction, blast damage. |
| `stdb-module/src/robot.rs` | Pure robot decision making (aim search, weapon policy, skill levels). |

`sim.rs` and `robot.rs` deliberately import nothing from `spacetimedb`, which is
what lets them be unit-tested on the host target.

📄 Robot opponent & solo play design: [`ROBOT_OPPONENT.md`](./ROBOT_OPPONENT.md) · SpacetimeDB + Vercel deployment: [`SPACETIMEDB_DEPLOY.md`](./SPACETIMEDB_DEPLOY.md) · Original design notes: [`MULTIPLAYER_ARCHITECTURE.md`](./MULTIPLAYER_ARCHITECTURE.md)

---

## 🧰 Tech Stack

**Next.js 15** · **React 19** · **Tailwind CSS 4** · **Framer Motion** · **lucide-react** · **SpacetimeDB** (Rust/WASM) · **Google Gemini API**

---

<div align="center">
<sub>Load your shot. Read the wind. <strong>Fire.</strong> 🎯💥</sub>
</div>
