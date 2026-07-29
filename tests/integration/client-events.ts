// Integration: the browser client's own event pipeline.
//
// Drives the real `MultiplayerConnection` (lib/multiplayer/spacetime.js) against
// the real module and checks the event stream the UI consumes, plus the feed
// lines derived from it. This is what app/page.jsx sees, minus React.

import { MultiplayerConnection } from "@/lib/multiplayer/spacetime";
import { describeEvent } from "@/lib/game/feed";

import { assert, assertEqual, randomCode, run, sleep, test, waitFor } from "./harness";

// The connection reaches for window.localStorage to cache its auth token and
// window.setTimeout to schedule reconnects. Node has neither, so stand in with
// the smallest thing that behaves correctly — a per-process token store.
function installBrowserGlobals() {
  if ((globalThis as { window?: unknown }).window) return;
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
}
installBrowserGlobals();

type Recorded = { type: string; event: Record<string, unknown> };

/** Open a connection and record everything it emits. */
function openClient(roomCode: string, options: Record<string, unknown> = {}) {
  const events: Recorded[] = [];
  const statuses: string[] = [];
  const feed: string[] = [];
  let myId: string | null = null;

  const connection = new MultiplayerConnection(
    roomCode,
    `client-${roomCode}`,
    null,
    "Commander",
    options
  );
  connection.onStatus((status: string) => statuses.push(status));
  connection.onMessage((event: Record<string, unknown>) => {
    if (event.type === "JOINED") myId = event.playerId as string;
    events.push({ type: event.type as string, event });
    const roster = (event.state as { players?: unknown[] } | undefined)?.players ?? [];
    const line = describeEvent(event, roster, myId);
    if (line) feed.push(line.text);
  });
  connection.connect();

  return {
    connection,
    events,
    statuses,
    feed,
    myId: () => myId,
    seen: (type: string) => events.filter((entry) => entry.type === type),
    latestState: () => {
      for (let i = events.length - 1; i >= 0; i--) {
        const state = events[i].event.state as Record<string, unknown> | undefined;
        if (state) return state;
      }
      return null;
    },
  };
}

test("a solo connection reports connected, started and the opening turn", async () => {
  const code = randomCode("C1");
  const client = openClient(code, { solo: true, difficulty: "normal" });

  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  assert(client.statuses.includes("connected"), "should report a connected status");
  assertEqual(client.seen("JOINED").length, 1, "exactly one JOINED");
  assert(client.seen("TURN_START").length > 0, "the opening turn should be announced");

  const state = client.latestState()!;
  assertEqual(state.status, "playing", "the match should start immediately in solo");
  assertEqual(state.solo, true, "state should carry the solo flag");

  const players = state.players as Array<Record<string, unknown>>;
  assertEqual(players.length, 2, "the robot should already be seated");
  const bot = players.find((p) => p.isRobot);
  assert(bot, "state should expose the robot flag the UI badges off");
  assertEqual(bot!.robotDifficulty, "normal", "difficulty should reach the UI");
  assertEqual((bot!.ammo as Record<string, number>).nuke, 1, "ammo should be mirrored");

  assert(
    client.feed.some((line) => line.startsWith("Battle joined")),
    `feed should open with the match: ${JSON.stringify(client.feed)}`
  );

  client.connection.disconnect();
});

test("the robot's shot arrives as spawn + impact with damage attribution", async () => {
  const code = randomCode("C2");
  const client = openClient(code, { solo: true, difficulty: "hard" });
  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  // Take our turn so the robot gets one. Straight up and weak: it lands on us,
  // which also proves damage attribution names the right tank.
  client.connection.fire(90, 15, "standard");

  const ourSpawn = await waitFor(
    "our shell",
    () => client.seen("SERVER_PROJECTILE_SPAWNED")[0] ?? null,
    20_000
  );
  assertEqual(ourSpawn.event.playerId, client.myId(), "the first shell is ours");
  assertEqual(ourSpawn.event.weaponId, "standard", "the weapon should be reported");
  assert(typeof ourSpawn.event.tti === "number", "spawn should carry a time-to-impact");

  const ourImpact = await waitFor("our impact", () => client.seen("SERVER_IMPACT")[0] ?? null);
  const selfDamage = ourImpact.event.damage as Array<{ playerId: string; amount: number }>;
  assertEqual(selfDamage.length, 1, "one tank should have been hit");
  assertEqual(selfDamage[0].playerId, client.myId(), "we shot ourselves");
  assert(selfDamage[0].amount > 0, "damage should be a positive number");
  assert(
    client.feed.some((line) => line.includes("hit you for")),
    `feed should name the damage: ${JSON.stringify(client.feed)}`
  );

  // Now the robot's turn: spawn, then impact, then the turn returns to us.
  const botSpawn = await waitFor(
    "the robot's shell",
    () => client.seen("SERVER_PROJECTILE_SPAWNED")[1] ?? null,
    20_000
  );
  const bot = (client.latestState()!.players as Array<Record<string, unknown>>).find(
    (p) => p.isRobot
  )!;
  assertEqual(botSpawn.event.playerId, bot.id, "the second shell belongs to the robot");
  assert(
    client.feed.some((line) => line.includes("fired a")),
    "the feed should log the shot"
  );

  await waitFor("the robot's impact", () => client.seen("SERVER_IMPACT").length >= 2, 20_000);
  await waitFor(
    "the turn to come back to us",
    () => {
      const state = client.latestState();
      return state?.activePlayerIndex === 0;
    },
    20_000
  );

  client.connection.disconnect();
});

test("no SYNC_STATE is emitted while a shell is airborne", async () => {
  const code = randomCode("C3");
  const client = openClient(code, { solo: true, difficulty: "hard" });
  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  const before = client.events.length;
  client.connection.fire(45, 55, "standard");
  await waitFor("spawn", () => client.seen("SERVER_PROJECTILE_SPAWNED").length > 0);

  // Between the spawn and its impact the client must not be handed a fresh
  // state — that would wipe the in-flight animation.
  const spawnIndex = client.events.findIndex(
    (entry, i) => i >= before && entry.type === "SERVER_PROJECTILE_SPAWNED"
  );
  const impactIndex = await waitFor("impact index", () => {
    const index = client.events.findIndex(
      (entry, i) => i > spawnIndex && entry.type === "SERVER_IMPACT"
    );
    return index > 0 ? index : null;
  });

  const between = client.events.slice(spawnIndex + 1, impactIndex).map((entry) => entry.type);
  assert(
    !between.includes("SYNC_STATE"),
    `state resync during flight would break the animation: ${JSON.stringify(between)}`
  );

  client.connection.disconnect();
});

test("aim updates are delivered on the cheap AIM_UPDATE path", async () => {
  const code = randomCode("C4");
  const client = openClient(code, { solo: true, difficulty: "normal" });
  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  const before = client.seen("SYNC_STATE").length;
  client.connection.aim(72, 44);

  const update = await waitFor("AIM_UPDATE", () => client.seen("AIM_UPDATE")[0] ?? null);
  assertEqual(update.event.playerId, client.myId(), "our own aim should echo back");
  assertEqual(update.event.angle, 72);
  assertEqual(update.event.power, 44);
  assertEqual(
    client.seen("SYNC_STATE").length,
    before,
    "an aim change must not trigger a full state resync"
  );

  client.connection.disconnect();
});

test("a failed action surfaces as an ERROR without dropping the connection", async () => {
  const code = randomCode("C5");
  const client = openClient(code, { solo: true, difficulty: "normal" });
  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  // Fire twice: the second is rejected because a shell is already in flight.
  client.connection.fire(45, 55, "standard");
  await waitFor("spawn", () => client.seen("SERVER_PROJECTILE_SPAWNED").length > 0);
  client.connection.fire(45, 55, "standard");

  const error = await waitFor("ERROR", () => client.seen("ERROR")[0] ?? null);
  assertEqual(error.event.code, "REDUCER_FAILED", "a rejected action is not a connection failure");
  assert(
    client.feed.some((line) => line === error.event.message),
    "the rejection should show up in the feed"
  );

  // The connection keeps working afterwards.
  await waitFor("impact", () => client.seen("SERVER_IMPACT").length > 0, 20_000);
  assert(!client.statuses.includes("error"), "the socket should still be healthy");

  client.connection.disconnect();
});

test("a solo match reaches MATCH_END with a winner the UI can name", async () => {
  const code = randomCode("C6");
  const client = openClient(code, { solo: true, difficulty: "hard" });
  await waitFor("MATCH_START", () => client.seen("MATCH_START").length > 0, 20_000);

  for (let turn = 0; turn < 12; turn++) {
    if (client.seen("MATCH_END").length > 0) break;
    if (client.latestState()?.activePlayerIndex === 0) {
      client.connection.fire(90, 15, "standard");
      await sleep(300);
    }
    await waitFor(
      "the turn to cycle",
      () =>
        client.latestState()?.activePlayerIndex === 0 || client.seen("MATCH_END").length > 0,
      40_000
    );
  }

  const ended = await waitFor("MATCH_END", () => client.seen("MATCH_END")[0] ?? null, 10_000);
  const state = ended.event.state as Record<string, unknown>;
  assertEqual(state.status, "finished");

  const players = state.players as Array<Record<string, unknown>>;
  const winner = players.find((p) => p.id === ended.event.winnerId);
  assert(winner, "the winner id should match a player the UI can render");
  assert(
    client.feed.some((line) => line.startsWith("Match over")),
    `the feed should close the match: ${JSON.stringify(client.feed.slice(-4))}`
  );

  client.connection.disconnect();
});

run("client event pipeline");
