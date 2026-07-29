// Integration: a solo match against the robot, driven end to end through the
// real module. Covers the acceptance criteria for solo play — one human can
// start a game, a robot is seated automatically, and it plays legal turns.

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

test("solo match seats a robot and starts without a second human", async () => {
  const code = randomCode("S1");
  const human = await connectClient("human", code);

  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Tester",
    clientId: "solo-1",
    difficulty: "normal",
  });

  const match = await waitFor("match to start", () => {
    const r = room(human, code);
    return r?.status === "playing" ? r : null;
  });

  assert(match.solo, "room should be flagged as solo");
  assertEqual(match.terrain.length, 1200, "terrain should be generated");

  const seated = players(human, code);
  assertEqual(seated.length, 2, "two tanks should be seated");

  const me = seated.find((p) => p.identity.toHexString() === human.identity);
  const bot = seated.find((p) => p.isRobot);
  assert(me, "human should be seated");
  assert(bot, "robot should be seated");
  assertEqual(me!.isRobot, false, "human must not be flagged as a robot");
  assertEqual(bot!.robotDifficulty, "normal", "robot should carry its difficulty");
  assertEqual(bot!.hp, 100, "robot starts at full health");
  assert(bot!.connected, "robot should always read as connected");
  assertEqual(match.activePlayerSlot, 0, "the human moves first");

  human.disconnect();
});

test("robot takes its turn automatically and legally", async () => {
  const code = randomCode("S2");
  const human = await connectClient("human", code);
  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Tester",
    clientId: "solo-2",
    difficulty: "hard",
  });
  await waitFor("match to start", () => room(human, code)?.status === "playing");

  const bot = () => players(human, code).find((p) => p.isRobot)!;
  const ammoBefore = bot().ammoStandard + bot().ammoCluster + bot().ammoNuke;
  const aimBefore = { angle: bot().angle, power: bot().power };

  // Human shot: deliberately weak so it lands harmlessly and hands over.
  await human.conn.reducers.fireWeapon({ angle: 45, power: 30, weaponId: "standard" });
  await waitFor("robot's turn", () => room(human, code)?.activePlayerSlot === 1);

  // The robot commits an aim before firing, so a watching client sees the
  // barrel move rather than being hit out of nowhere.
  await waitFor(
    "robot to commit an aim",
    () => bot().angle !== aimBefore.angle || bot().power !== aimBefore.power
  );

  const aimed = bot();
  assert(aimed.angle > 90 && aimed.angle <= 180, `robot must fire leftward, got ${aimed.angle}`);
  assert(aimed.power >= 1 && aimed.power <= 100, `power out of range: ${aimed.power}`);

  const shot = await waitFor("robot's shell in flight", () => projectiles(human, code)[0] ?? null);
  assertEqual(
    shot.playerIdentity.toHexString(),
    aimed.identity.toHexString(),
    "the shell should belong to the robot"
  );
  assert(
    ["standard", "cluster", "nuke"].includes(shot.weaponId),
    `unexpected weapon ${shot.weaponId}`
  );

  await waitFor("turn to come back to the human", () => room(human, code)?.activePlayerSlot === 0);

  const ammoAfter = bot().ammoStandard + bot().ammoCluster + bot().ammoNuke;
  assertEqual(ammoAfter, ammoBefore - 1, "robot should spend exactly one shell per turn");
  assertEqual(bot().shotsFired, 1, "robot's shot should be counted");

  human.disconnect();
});

test("robot cannot be driven by a client and never fires out of turn", async () => {
  const code = randomCode("S3");
  const human = await connectClient("human", code);
  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Tester",
    clientId: "solo-3",
    difficulty: "easy",
  });
  await waitFor("match to start", () => room(human, code)?.status === "playing");

  // It's the human's turn; the robot must not have fired.
  await sleep(2_500); // longer than think + aim delay
  assertEqual(room(human, code)!.activePlayerSlot, 0, "turn should still be the human's");
  assertEqual(
    players(human, code).find((p) => p.isRobot)!.shotsFired,
    0,
    "robot must not shoot on the human's turn"
  );

  // The robot is driven by scheduled reducers, which are not part of the
  // client API at all — there is no handle for a client to grab. (The module
  // also rejects them server-side via `scheduler_only`, belt and braces.)
  const reducers = human.conn.reducers as unknown as Record<string, unknown>;
  for (const scheduled of [
    "processRobotTurn",
    "processImpact",
    "processTurnTimeout",
    "processForfeit",
    "processRoomCleanup",
  ]) {
    assertEqual(
      typeof reducers[scheduled],
      "undefined",
      `${scheduled} must not be exposed to clients`
    );
  }

  human.disconnect();
});

test("a solo room is private — nobody else can join it", async () => {
  const code = randomCode("S4");
  const human = await connectClient("human", code);
  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Owner",
    clientId: "solo-4",
    difficulty: "normal",
  });
  await waitFor("match to start", () => room(human, code)?.status === "playing");

  const stranger = await connectClient("stranger", code);
  const rejected = await stranger.conn.reducers
    .joinMatch({ roomCode: code, name: "Intruder", clientId: "intruder" })
    .then(() => null)
    .catch((error: unknown) => error);

  assert(rejected, "joining a solo room should be rejected");
  assertEqual(players(human, code).length, 2, "the solo room should still hold two tanks");

  stranger.disconnect();
  human.disconnect();
});

test("a solo match plays through to a resolved winner", async () => {
  const code = randomCode("S5");
  const human = await connectClient("human", code);
  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Tester",
    clientId: "solo-5",
    difficulty: "hard",
  });
  await waitFor("match to start", () => room(human, code)?.status === "playing");

  const bot = () => players(human, code).find((p) => p.isRobot)!;
  const startingTerrain = [...room(human, code)!.terrain];

  // The human lobs straight up so the shell lands on its own hull. That drains
  // it fast and keeps the test short, while still exercising a full alternating
  // turn cycle: damage, terrain destruction, handoff and completion.
  for (let turn = 0; turn < 12; turn++) {
    const state = room(human, code)!;
    if (state.status === "finished") break;
    if (state.activePlayerSlot === 0) {
      await human.conn.reducers.fireWeapon({ angle: 90, power: 15, weaponId: "standard" });
      await waitFor("our shot to resolve", () => projectiles(human, code).length === 0);
    }
    await waitFor(
      "the turn to move on",
      () => room(human, code)!.activePlayerSlot === 0 || room(human, code)!.status === "finished",
      40_000
    );
  }

  const finished = await waitFor(
    "the match to finish",
    () => {
      const r = room(human, code);
      return r?.status === "finished" ? r : null;
    },
    5_000
  );

  assert(!finished.turnStartedAt, "a finished match should not hold a live turn clock");
  const survivors = players(human, code).filter((p) => p.hp > 0);
  assert(survivors.length <= 1, `expected at most one survivor, got ${survivors.length}`);
  if (finished.winnerIdentity) {
    assertEqual(
      finished.winnerIdentity.toHexString(),
      survivors[0].identity.toHexString(),
      "the winner should be the surviving tank"
    );
  } else {
    assertEqual(survivors.length, 0, "a draw means nobody survived");
  }
  assert(bot().shotsFired > 0, "robot should have taken shots");
  assert(
    finished.terrain.some((y, i) => y !== startingTerrain[i]),
    "explosions should have reshaped the terrain"
  );

  human.disconnect();
});

test("leaving a solo match tears the room down", async () => {
  const code = randomCode("S6");
  const human = await connectClient("human", code);
  await human.conn.reducers.createSoloMatch({
    roomCode: code,
    name: "Tester",
    clientId: "solo-6",
    difficulty: "normal",
  });
  await waitFor("match to start", () => room(human, code)?.status === "playing");

  await human.conn.reducers.leaveMatch({});
  await waitFor("the room to disappear", () => room(human, code) === null);
  assertEqual(players(human, code).length, 0, "the robot should be cleaned up too");

  human.disconnect();
});

test("solo matches can be restarted on a fresh room code", async () => {
  const first = randomCode("S7");
  const human = await connectClient("human", first);
  await human.conn.reducers.createSoloMatch({
    roomCode: first,
    name: "Tester",
    clientId: "solo-7",
    difficulty: "normal",
  });
  await waitFor("first match", () => room(human, first)?.status === "playing");

  const second = randomCode("S8");
  const rematch = await connectClient("human-again", second);
  await rematch.conn.reducers.createSoloMatch({
    roomCode: second,
    name: "Tester",
    clientId: "solo-7",
    difficulty: "easy",
  });
  await waitFor("second match", () => room(rematch, second)?.status === "playing");

  assertEqual(players(rematch, second).length, 2, "the rematch should be fully seated");
  assertEqual(
    players(rematch, second).find((p) => p.isRobot)!.robotDifficulty,
    "easy",
    "the rematch should honour the new difficulty"
  );

  rematch.disconnect();
  human.disconnect();
});

run("solo robot flow");
