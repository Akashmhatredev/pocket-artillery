# Deploying Pocket Artillery — SpacetimeDB + Vercel

Pocket Artillery's multiplayer backend runs entirely on **SpacetimeDB**. A
single WebAssembly module (`stdb-module/`, written in Rust) replaces the old
PartyKit realtime server **and** the Supabase database — it holds all game
state in tables and runs all authoritative logic (turns, physics, damage,
terrain destruction) as reducers. The browser connects **directly** to
SpacetimeDB over a WebSocket and subscribes to those tables.

> **Important mental model:** you do **not** deploy SpacetimeDB to Vercel.
> Vercel hosts only the Next.js frontend. SpacetimeDB runs separately — on
> **Maincloud** (SpacetimeDB's managed cloud) in production, or locally during
> development. The frontend is pointed at whichever one you're using via two
> environment variables.

```
┌─────────────────────┐     WebSocket (wss)      ┌──────────────────────────┐
│   Next.js frontend  │ ◀──────────────────────▶ │  SpacetimeDB module      │
│   (hosted on Vercel)│   subscribe + reducers   │  (Maincloud)             │
│   canvas game engine│                          │  tables + reducers +     │
│                     │                          │  authoritative physics   │
└─────────────────────┘                          └──────────────────────────┘
```

---

## Repository layout

| Path | What it is |
| :--- | :--------- |
| `stdb-module/` | The Rust SpacetimeDB module (server logic + schema). |
| `module_bindings/` | **Generated** TypeScript client bindings. Committed so Vercel can build without the CLI. Regenerate whenever the module changes. |
| `lib/multiplayer/spacetime.js` | Browser-side connection adapter (subscribes to tables, calls reducers). |
| `app/page.jsx` | Game UI. Talks only to the adapter. |

---

## 0. Prerequisites (one-time)

Install the toolchains locally. (Vercel does **not** need these — see step 4.)

```bash
# Rust + the WebAssembly target the module compiles to
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown

# The SpacetimeDB CLI
curl -sSf https://install.spacetimedb.com | sh
# add to PATH for this shell (installer prints the exact path):
export PATH="$HOME/.local/bin:$PATH"
spacetime --version   # verified against 2.6.1

# Node 20+ (this project is developed against Node 24)
node -v
```

> Optional: install [`wasm-opt`](https://github.com/WebAssembly/binaryen/releases)
> to shrink the published module. The CLI works without it (it just prints a
> warning and publishes an unoptimised build).

> **Version alignment:** the Rust crate in `stdb-module/Cargo.toml`
> (`spacetimedb = "1.0"`, which resolves to the latest `1.x`) must be
> ABI-compatible with your installed CLI. If `spacetime publish` reports an ABI
> mismatch, bump/pin the crate to match the version your CLI expects.

---

## 1. Run everything locally

Four terminals' worth of commands, but you only do the setup once.

```bash
# (a) Start a local SpacetimeDB instance (listens on 127.0.0.1:3000)
npm run stdb:start          # = spacetime start   — leave this running

# (b) Publish the module to the local instance
spacetime publish -p stdb-module --server local pocket-artillery

# (c) Generate the TypeScript client bindings from the module
npm run stdb:generate       # writes module_bindings/

# (d) Point the frontend at the local instance
cp .env.example .env.local
# ensure .env.local contains:
#   NEXT_PUBLIC_SPACETIMEDB_URI="ws://localhost:3000"
#   NEXT_PUBLIC_SPACETIMEDB_MODULE="pocket-artillery"

# (e) Run the app (on :3001 — SpacetimeDB owns :3000)
npm install
npm run dev
```

Open **http://localhost:3001**, create a room in one tab, and join with the
room code from a second tab (or another browser) to test a live match.
Single-player works with no backend running at all.

> ⚠️ **Port collision:** SpacetimeDB's local server and Next.js both default to
> port **3000**. `npm run dev` is configured to run the app on **3001** so the
> two don't fight. The frontend still connects to SpacetimeDB at
> `ws://localhost:3000` (set in `.env.local`).

**After any change to `stdb-module/src/lib.rs`:** re-run (b) and (c):

```bash
spacetime publish -p stdb-module --server local pocket-artillery
npm run stdb:generate
```

---

## 2. Deploy the module to Maincloud (production backend)

Maincloud is SpacetimeDB's managed cloud — no server to run.

```bash
# Log in to Maincloud (opens a browser for the global spacetimedb.com login)
spacetime login

# Publish. Names on Maincloud are global — if "pocket-artillery" is taken,
# pick a unique one (e.g. "pocket-artillery-<yourhandle>").
spacetime publish -p stdb-module --server maincloud pocket-artillery
```

The CLI prints the database name/identity it published to. **That name is your
`NEXT_PUBLIC_SPACETIMEDB_MODULE` value** for production. The production URI is
always `wss://maincloud.spacetimedb.com`.

Useful checks:

```bash
spacetime logs --server maincloud pocket-artillery          # tail module logs
spacetime sql  --server maincloud pocket-artillery "SELECT room_code, status FROM match_room"
```

---

## 3. Generate & commit the bindings

The frontend imports `@/module_bindings`, which is generated code. Vercel
builds from your Git repo and has no Rust/CLI toolchain, so the bindings **must
be committed**:

```bash
npm run stdb:generate
git add module_bindings stdb-module
git commit -m "chore: SpacetimeDB module + generated bindings"
```

The bindings describe the module's schema (table/reducer shapes), which is the
same whether you published to `local` or `maincloud`, so a single committed
copy works for both. Regenerate and recommit whenever the module changes.

---

## 4. Deploy the frontend to Vercel

1. Push the repo to GitHub/GitLab/Bitbucket and **Import Project** in Vercel.
2. Framework preset: **Next.js** (auto-detected). Build command `next build`,
   output handled automatically. No special settings needed — `module_bindings/`
   is already in the repo.
3. Add **Environment Variables** (Production, Preview, and Development):

   | Name | Value |
   | :--- | :---- |
   | `NEXT_PUBLIC_SPACETIMEDB_URI` | `wss://maincloud.spacetimedb.com` |
   | `NEXT_PUBLIC_SPACETIMEDB_MODULE` | the name you published in step 2 (e.g. `pocket-artillery`) |
   | `GEMINI_API_KEY` | your key (if you use the Gemini features) |

   Both `NEXT_PUBLIC_*` values are safe to expose — the browser needs them to
   open the WebSocket, and SpacetimeDB reducers enforce all the rules
   server-side regardless.
4. **Deploy.** Vercel runs `next build`, which compiles the committed bindings
   and adapter. When the site loads, the browser connects straight to Maincloud.

That's the whole pipeline: **frontend → Vercel**, **module → Maincloud**,
bindings committed to bridge the two.

---

## 5. The ongoing loop (when you change game logic)

```bash
# 1. edit stdb-module/src/lib.rs
# 2. republish to Maincloud
spacetime publish -p stdb-module --server maincloud pocket-artillery
# 3. regenerate + commit bindings
npm run stdb:generate && git add -A && git commit -m "feat: <change>"
# 4. push → Vercel auto-deploys the frontend
git push
```

If a schema change is breaking, `spacetime publish` will warn you and may
require `--delete-data` (wipes the database) or a migration. For a game with no
long-lived data to preserve, `--delete-data` is usually fine in development.

---

## Troubleshooting

| Symptom | Fix |
| :------ | :-- |
| `next build` fails on `@/module_bindings` | You haven't generated bindings yet. Run `npm run stdb:generate` and commit the result. |
| Multiplayer shows a "bindings have not been generated" error at runtime | Same as above — the placeholder stub is still in place. |
| `spacetime publish` reports an ABI / version mismatch | Align `spacetimedb` crate version in `stdb-module/Cargo.toml` with your CLI (`spacetime --version`). |
| `WebSocket connection to 'wss://maincloud.spacetimedb.com/v1/database/<name>/subscribe' failed` | The database doesn't exist on that server (not published there) **or** the name in `NEXT_PUBLIC_SPACETIMEDB_MODULE` doesn't match. Run `spacetime list --server maincloud` to see what you've actually published, and set the env var to that exact name. Publishing to `local` does **not** put it on Maincloud. |
| Browser can't connect in production | Confirm `NEXT_PUBLIC_SPACETIMEDB_URI` is `wss://…` (not `ws://`) and the module name matches exactly what `spacetime publish --server maincloud` printed. |
| WebSocket fails on `ws://localhost:3000` locally | Make sure `spacetime start` is actually running on :3000 and the app is on a different port (`npm run dev` uses :3001). Both default to 3000 and will collide. |
| Match never starts with two players | Both players must hold an open connection. This is normal in the real app; note that one-shot `spacetime call` commands can't simulate two persistent clients. |
| Want to self-host instead of Maincloud | Run `spacetime start` (or `spacetimedb-standalone`) on a VM/container behind TLS, publish there with `--server <your-url>`, and set `NEXT_PUBLIC_SPACETIMEDB_URI` to its `wss://` address. |
