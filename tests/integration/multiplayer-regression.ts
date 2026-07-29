// Integration: two-human multiplayer, unchanged by the robot work.
//
// The robot feature added tables columns, new reducers and a turn handoff hook.
// This suite is the regression net for the paths that already existed: seating,
// turn order, authority checks, ammo, impacts, pause/resume and forfeits.

import {
  assert,
  assertEqual,
  connectClient,
  players,
  projectiles,
  randomCode,
  room,
  run,
  sleep,
  test,
  waitFor,
} from "./harness";

test("two humans seat themselves and the match starts", async () => {
  const code = randomCode("M1");
  const host = await connectClient("host", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-1a" });

  const waiting = await waitFor("room to exist", () => room(host, code));
  assertEqual(waiting.status, "waiting", "one player is not enough to start");
  assertEqual(waiting.solo, false, "a joined room must not be flagged solo");

  const guest = await connectClient("guest", code);
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-1b" });

  const started = await waitFor("match to start", () => {
    const r = room(host, code);
    return r?.status === "playing" ? r : null;
  });

  const seated = players(host, code);
  assertEqual(seated.length, 2, "both humans should be seated");
  assertEqual(
    seated.filter((p) => p.isRobot).length,
    0,
    "a multiplayer room must never contain a robot"
  );
  assertEqual(seated[0].name, "Host", "slot 0 is the host");
  assertEqual(seated[1].name, "Guest", "slot 1 is the guest");
  assertEqual(started.activePlayerSlot, 0, "the host moves first");
  assertEqual(started.terrain.length, 1200, "terrain should be generated");
  assert(started.turnStartedAt, "the turn clock should be running");

  guest.disconnect();
  host.disconnect();
});

test("only the active player can fire, and firing hands over the turn", async () => {
  const code = randomCode("M2");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-2a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-2b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  // Guest is not the active player.
  const rejected = await guest.conn.reducers
    .fireWeapon({ angle: 135, power: 60, weaponId: "standard" })
    .then(() => null)
    .catch((error: unknown) => error);
  assert(rejected, "an off-turn shot must be rejected");
  assertEqual(projectiles(host, code).length, 0, "no shell should have been created");

  const hostBefore = players(host, code)[0];
  await host.conn.reducers.fireWeapon({ angle: 50, power: 55, weaponId: "standard" });

  const shell = await waitFor("shell in flight", () => projectiles(guest, code)[0] ?? null);
  assertEqual(
    shell.playerIdentity.toHexString(),
    host.identity,
    "the shell should belong to the host"
  );

  // A second shot while one is airborne is refused.
  const doubleShot = await host.conn.reducers
    .fireWeapon({ angle: 50, power: 55, weaponId: "standard" })
    .then(() => null)
    .catch((error: unknown) => error);
  assert(doubleShot, "firing twice in one turn must be rejected");

  await waitFor("impact", () => projectiles(host, code).length === 0);
  await waitFor("turn to pass to the guest", () => room(host, code)?.activePlayerSlot === 1);

  const hostAfter = players(host, code)[0];
  assertEqual(
    hostAfter.ammoStandard,
    hostBefore.ammoStandard - 1,
    "exactly one shell should be spent"
  );
  assertEqual(hostAfter.shotsFired, 1, "the shot should be counted");

  guest.disconnect();
  host.disconnect();
});

test("aim updates replicate to the opponent", async () => {
  const code = randomCode("M3");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-3a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-3b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  await host.conn.reducers.aim({ angle: 63.5, power: 42 });
  const mirrored = await waitFor("guest to see the new aim", () => {
    const seen = players(guest, code).find((p) => p.identity.toHexString() === host.identity);
    return seen && Math.abs(seen.angle - 63.5) < 0.01 ? seen : null;
  });
  assert(Math.abs(mirrored.power - 42) < 0.01, `power should replicate, got ${mirrored.power}`);

  // Out-of-range aim is clamped rather than rejected.
  await host.conn.reducers.aim({ angle: 999, power: -20 });
  const clamped = await waitFor("clamped aim", () => {
    const seen = players(guest, code).find((p) => p.identity.toHexString() === host.identity);
    return seen && seen.angle === 180 ? seen : null;
  });
  assertEqual(clamped.power, 1, "power should clamp to the minimum");

  guest.disconnect();
  host.disconnect();
});

test("weapon selection is remembered per player", async () => {
  const code = randomCode("M4");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-4a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-4b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  await host.conn.reducers.selectWeapon({ weaponId: "nuke" });
  await waitFor(
    "guest to see the pick",
    () =>
      players(guest, code).find((p) => p.identity.toHexString() === host.identity)
        ?.selectedWeapon === "nuke"
  );

  // Unknown weapons fall back to standard instead of erroring.
  await host.conn.reducers.selectWeapon({ weaponId: "railgun" });
  await waitFor(
    "unknown weapon to normalize",
    () =>
      players(guest, code).find((p) => p.identity.toHexString() === host.identity)
        ?.selectedWeapon === "standard"
  );

  guest.disconnect();
  host.disconnect();
});

test("a third player cannot squeeze into a full room", async () => {
  const code = randomCode("M5");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-5a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-5b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  const third = await connectClient("third", code);
  const rejected = await third.conn.reducers
    .joinMatch({ roomCode: code, name: "Third", clientId: "mp-5c" })
    .then(() => null)
    .catch((error: unknown) => error);

  assert(rejected, "a third join should be rejected");
  assertEqual(players(host, code).length, 2, "the room should still hold two players");

  // ...and a solo match cannot hijack an existing multiplayer room either.
  const hijack = await third.conn.reducers
    .createSoloMatch({ roomCode: code, name: "Third", clientId: "mp-5c", difficulty: "hard" })
    .then(() => null)
    .catch((error: unknown) => error);
  assert(hijack, "turning a live multiplayer room into a solo match must be rejected");

  third.disconnect();
  guest.disconnect();
  host.disconnect();
});

test("a dropped player pauses the match and resuming restores play", async () => {
  const code = randomCode("M6");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-6a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-6b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  guest.disconnect();

  const paused = await waitFor("match to pause", () => {
    const r = room(host, code);
    return r?.status === "paused" ? r : null;
  });
  assert(paused.disconnectDeadline, "a reconnect deadline should be armed");

  // Firing is refused while the match is paused.
  const rejected = await host.conn.reducers
    .fireWeapon({ angle: 45, power: 60, weaponId: "standard" })
    .then(() => null)
    .catch((error: unknown) => error);
  assert(rejected, "firing during a pause must be rejected");

  // Same token => same identity => same seat.
  const returning = await connectClient("guest-again", code, guest.token);
  assertEqual(returning.identity, guest.identity, "the reconnect should reuse the identity");
  await returning.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-6b" });

  const resumed = await waitFor("match to resume", () => {
    const r = room(host, code);
    return r?.status === "playing" ? r : null;
  });
  assert(!resumed.disconnectDeadline, "the deadline should be cleared on resume");
  assertEqual(players(host, code).length, 2, "both players should still be seated");
  assert(
    players(host, code).every((p) => p.connected),
    "both players should read as connected"
  );

  returning.disconnect();
  host.disconnect();
});

test("leaving a shared room keeps it alive for the other player", async () => {
  const code = randomCode("M7");
  const host = await connectClient("host", code);
  const guest = await connectClient("guest", code);
  await host.conn.reducers.joinMatch({ roomCode: code, name: "Host", clientId: "mp-7a" });
  await guest.conn.reducers.joinMatch({ roomCode: code, name: "Guest", clientId: "mp-7b" });
  await waitFor("match to start", () => room(host, code)?.status === "playing");

  await guest.conn.reducers.leaveMatch({});
  await waitFor("guest seat to clear", () => players(host, code).length === 1);
  assert(room(host, code), "the room should survive while a human remains");

  // Once the last human leaves, the room goes away.
  await host.conn.reducers.leaveMatch({});
  await waitFor("room to disappear", () => room(host, code) === null);

  guest.disconnect();
  host.disconnect();
});

test("switching rooms releases the previous seat", async () => {
  const first = randomCode("M8");
  const second = randomCode("M9");
  const host = await connectClient("host", first);
  await host.conn.reducers.joinMatch({ roomCode: first, name: "Host", clientId: "mp-8a" });
  await waitFor("first room", () => room(host, first));

  // Subscribed to `first` only, so re-subscribe to watch the second room.
  const moved = await connectClient("host-elsewhere", second, host.token);
  await moved.conn.reducers.joinMatch({ roomCode: second, name: "Host", clientId: "mp-8a" });
  await waitFor("seat in the second room", () => players(moved, second).length === 1);

  assertEqual(
    players(moved, second)[0].identity.toHexString(),
    host.identity,
    "the same identity should hold the new seat"
  );
  // The abandoned room had no other players, so it should be gone.
  await sleep(200);
  assertEqual(room(host, first), null, "the vacated room should be cleaned up");

  moved.disconnect();
  host.disconnect();
});

run("multiplayer regression");
