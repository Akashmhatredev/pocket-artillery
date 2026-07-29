// Unit tests for the client-side render/prediction engine.
// Run with: npm run test:unit

import assert from "node:assert/strict";
import test from "node:test";

import { GameEngine } from "../../lib/engine.js";

const flatTerrain = (height = 500) => new Array(1200).fill(height);

const serverState = (overrides = {}) => ({
  status: "playing",
  terrain: flatTerrain(),
  activePlayerIndex: 0,
  wind: 0,
  winnerId: null,
  players: [
    {
      id: "human",
      slot: 0,
      name: "Commander",
      color: "#22d3ee",
      hp: 100,
      angle: 45,
      power: 60,
      x: 200,
      y: 500,
      connected: true,
      isRobot: false,
      shotsFired: 1,
    },
    {
      id: "robot",
      slot: 1,
      name: "Overlord",
      color: "#a78bfa",
      hp: 80,
      angle: 135,
      power: 55,
      x: 1000,
      y: 500,
      connected: true,
      isRobot: true,
      robotDifficulty: "hard",
      shotsFired: 2,
    },
  ],
  ...overrides,
});

test("a fresh engine seats two tanks on the terrain", () => {
  const engine = new GameEngine();
  assert.equal(engine.players.length, 2);
  assert.equal(engine.winner, null);
  assert.equal(engine.currentPlayerIndex, 0);
  for (const player of engine.players) {
    assert.equal(player.y, engine.getTerrainHeight(player.x));
    assert.ok(!player.isRobot, "practice tanks are not robots");
  }
});

test("server state carries robot metadata through to the render state", () => {
  const engine = new GameEngine();
  let published = null;
  engine.onStateChange = (state) => {
    published = state;
  };

  engine.applyServerState(serverState());

  const [human, robot] = engine.players;
  assert.equal(human.isRobot, false);
  assert.equal(robot.isRobot, true);
  assert.equal(robot.robotDifficulty, "hard");
  assert.equal(robot.shotsFired, 2);

  // notifyUI deep-clones, so the flags must survive the round trip that feeds
  // the HUD badges.
  assert.equal(published.players[1].isRobot, true);
  assert.equal(published.players[1].name, "Overlord");
  assert.equal(published.isFiring, false);
});

test("a finished match resolves the winning tank, robot or not", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState({ status: "finished", winnerId: "robot" }));
  assert.equal(engine.winner.name, "Overlord");
  assert.equal(engine.winner.isRobot, true);
});

test("a finished match with no winner is a draw", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState({ status: "finished", winnerId: null }));
  assert.equal(engine.winner.name, "Draw");
});

test("returning to a live status clears the winner", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState({ status: "finished", winnerId: "robot" }));
  engine.applyServerState(serverState());
  assert.equal(engine.winner, null);
});

test("network aim updates ease the barrel instead of snapping", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState());
  engine.applyAimUpdate({ playerId: "robot", angle: 160, power: 90 });

  const robot = engine.players[1];
  assert.equal(robot.angle, 135, "the aim should not jump on arrival");

  engine.tick();
  assert.ok(robot.angle > 135 && robot.angle < 160, `expected easing, got ${robot.angle}`);

  for (let i = 0; i < 60; i++) engine.tick();
  assert.equal(robot.angle, 160, "easing should settle exactly on the target");
  assert.equal(robot.power, 90);
});

test("aim updates for an unknown player are ignored", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState());
  engine.applyAimUpdate({ playerId: "ghost", angle: 10, power: 10 });
  assert.equal(engine.players[0].angle, 45);
  assert.equal(engine.players[1].angle, 135);
});

test("an authoritative projectile animates without predicting its own impact", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState());
  engine.spawnNetworkProjectile({
    id: "7",
    playerId: "robot",
    weaponId: "nuke",
    x: 1000,
    y: 480,
    vx: -12,
    vy: -8,
  });

  assert.equal(engine.projectiles.length, 1);
  assert.equal(engine.isFiring, true);
  assert.equal(engine.projectiles[0].authoritative, true);

  // Fly it into the ground: the client must not resolve the hit itself, the
  // server's impact event does that.
  for (let i = 0; i < 200; i++) engine.tick();
  assert.equal(engine.projectiles.length, 1, "the server owns the impact");
  assert.equal(engine.players[0].hp, 100, "no client-side damage");
});

test("a server impact clears the shell and applies the authoritative state", () => {
  const engine = new GameEngine();
  engine.applyServerState(serverState());
  engine.spawnNetworkProjectile({
    id: "7",
    playerId: "robot",
    weaponId: "standard",
    x: 1000,
    y: 480,
    vx: -12,
    vy: -8,
  });

  const damaged = serverState();
  damaged.players[0].hp = 61;
  engine.applyServerImpact({ projectileId: "7", x: 200, y: 492, radius: 60, state: damaged });

  assert.equal(engine.projectiles.length, 0);
  assert.equal(engine.isFiring, false);
  assert.equal(engine.players[0].hp, 61, "HP comes from the server, not local physics");
  assert.ok(engine.particles.length > 0, "the blast should still spawn particles");
});

test("practice mode fires locally and refuses a second shot mid-flight", () => {
  const engine = new GameEngine();
  engine.fire("standard");
  assert.equal(engine.projectiles.length, 1);
  assert.equal(engine.isFiring, true);

  engine.fire("nuke");
  assert.equal(engine.projectiles.length, 1, "one shot per turn");
});

test("explosions carve terrain and damage with falloff", () => {
  const engine = new GameEngine();
  engine.terrain = flatTerrain();
  engine.players = [
    { id: 1, name: "A", color: "#fff", hp: 100, angle: 45, power: 60, x: 600, y: 500 },
    { id: 2, name: "B", color: "#fff", hp: 100, angle: 135, power: 60, x: 640, y: 500 },
  ];

  engine.explode(600, 492, 60, 25, "standard");

  assert.ok(engine.terrain[600] > 500, "the crater should deepen the terrain");
  assert.equal(engine.terrain[0], 500, "distant terrain is untouched");
  assert.ok(engine.players[0].hp < engine.players[1].hp, "the closer tank takes more");
  assert.ok(engine.players[1].hp < 100, "the nearby tank still takes splash");
});

test("the local name only renames the local tank", () => {
  const engine = new GameEngine();
  engine.setLocalName("Ripley");
  assert.equal(engine.players[0].name, "Ripley");
  assert.equal(engine.players[1].name, "Omega");

  // A reset must not lose the callsign.
  engine.reset();
  assert.equal(engine.players[0].name, "Ripley");
});
