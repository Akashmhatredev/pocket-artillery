// Unit tests for the activity-feed / scoreboard helpers.
// Run with: npm run test:unit

import assert from "node:assert/strict";
import test from "node:test";

import {
  FEED_LIMIT,
  appendFeed,
  buildSummary,
  describeEvent,
  describeOutcome,
  difficultyLabel,
  weaponLabel,
} from "../../lib/game/feed.js";

const ME = "me-hex";
const BOT = "bot-hex";

const roster = [
  { id: ME, slot: 0, name: "Commander", color: "#22d3ee", hp: 70, shotsFired: 3, isRobot: false },
  {
    id: BOT,
    slot: 1,
    name: "Overlord",
    color: "#a78bfa",
    hp: 0,
    shotsFired: 4,
    isRobot: true,
    robotDifficulty: "hard",
  },
];

const state = (overrides = {}) => ({ players: roster, winnerId: null, ...overrides });

test("weapon labels cover every id and fall back safely", () => {
  assert.equal(weaponLabel("standard"), "Standard Shell");
  assert.equal(weaponLabel("cluster"), "Cluster Bomb");
  assert.equal(weaponLabel("nuke"), "Mini Nuke");
  assert.equal(weaponLabel("railgun"), "Standard Shell");
  assert.equal(weaponLabel(undefined), "Standard Shell");
});

test("difficulty labels are title-cased, and empty stays empty", () => {
  assert.equal(difficultyLabel("hard"), "Hard");
  assert.equal(difficultyLabel("normal"), "Normal");
  assert.equal(difficultyLabel(null), null);
  assert.equal(difficultyLabel(""), null);
});

test("a robot's turn is flagged so the UI can badge it", () => {
  const entry = describeEvent({ type: "TURN_START", playerId: BOT, state: state() }, [], ME);
  assert.equal(entry.robot, true);
  assert.match(entry.text, /Overlord/);
  assert.equal(entry.tone, "info");
});

test("my own turn reads as mine and is not badged", () => {
  const entry = describeEvent({ type: "TURN_START", playerId: ME, state: state() }, [], ME);
  assert.equal(entry.robot, false);
  assert.match(entry.text, /Your turn/);
  assert.equal(entry.tone, "good");
});

test("robot shots are described with the weapon and a robot flag", () => {
  const entry = describeEvent(
    { type: "SERVER_PROJECTILE_SPAWNED", playerId: BOT, weaponId: "nuke" },
    roster,
    ME
  );
  assert.equal(entry.text, "Overlord fired a Mini Nuke");
  assert.equal(entry.robot, true);
});

test("a spawn with no state still names the shooter from the cached roster", () => {
  const entry = describeEvent(
    { type: "SERVER_PROJECTILE_SPAWNED", playerId: ME, weaponId: "cluster" },
    roster,
    ME
  );
  assert.equal(entry.text, "Commander fired a Cluster Bomb");
  assert.equal(entry.tone, "good");
});

test("an unknown shooter degrades gracefully", () => {
  const entry = describeEvent(
    { type: "SERVER_PROJECTILE_SPAWNED", playerId: "ghost", weaponId: "standard" },
    roster,
    ME
  );
  assert.equal(entry.text, "Someone fired a Standard Shell");
  assert.equal(entry.robot, false);
});

test("damage to me reads as bad news, damage to the robot as good", () => {
  const hitMe = describeEvent(
    {
      type: "SERVER_IMPACT",
      weaponId: "nuke",
      damage: [{ playerId: ME, name: "Commander", amount: 41 }],
      state: state(),
    },
    [],
    ME
  );
  assert.equal(hitMe.text, "Mini Nuke hit you for 41");
  assert.equal(hitMe.tone, "bad");

  const hitBot = describeEvent(
    {
      type: "SERVER_IMPACT",
      weaponId: "standard",
      damage: [{ playerId: BOT, name: "Overlord", amount: 22 }],
      state: state(),
    },
    [],
    ME
  );
  assert.equal(hitBot.text, "Standard Shell hit Overlord for 22");
  assert.equal(hitBot.tone, "good");
});

test("a blast that catches both tanks is reported once", () => {
  const entry = describeEvent(
    {
      type: "SERVER_IMPACT",
      weaponId: "nuke",
      damage: [
        { playerId: ME, name: "Commander", amount: 30 },
        { playerId: BOT, name: "Overlord", amount: 12 },
      ],
      state: state(),
    },
    [],
    ME
  );
  assert.equal(entry.text, "Mini Nuke hit you for 30 and Overlord for 12");
  assert.equal(entry.tone, "bad", "any damage to me colours the line as bad");
});

test("a harmless impact is reported as a miss", () => {
  const entry = describeEvent(
    { type: "SERVER_IMPACT", weaponId: "cluster", damage: [], state: state() },
    [],
    ME
  );
  assert.equal(entry.text, "Cluster Bomb missed");
  assert.equal(entry.tone, "warn");
});

test("impacts with no damage field are treated as misses", () => {
  const entry = describeEvent({ type: "SERVER_IMPACT", weaponId: "standard" }, roster, ME);
  assert.equal(entry.text, "Standard Shell missed");
});

test("match end names the winner and marks a draw", () => {
  const lost = describeEvent({ type: "MATCH_END", winnerId: BOT, state: state() }, [], ME);
  assert.equal(lost.text, "Match over — Overlord wins");
  assert.equal(lost.tone, "bad");
  assert.equal(lost.robot, true);

  const won = describeEvent({ type: "MATCH_END", winnerId: ME, state: state() }, [], ME);
  assert.equal(won.text, "Match over — you win");
  assert.equal(won.tone, "good");

  const draw = describeEvent({ type: "MATCH_END", winnerId: null, state: state() }, [], ME);
  assert.equal(draw.text, "Match over — draw");
});

test("noisy and unknown events produce no feed lines", () => {
  assert.equal(describeEvent({ type: "AIM_UPDATE", angle: 40, power: 50 }, roster, ME), null);
  assert.equal(describeEvent({ type: "SYNC_STATE", state: state() }, roster, ME), null);
  assert.equal(describeEvent({ type: "JOINED", playerId: ME }, roster, ME), null);
  assert.equal(describeEvent({ type: "ERROR", message: "" }, roster, ME), null);
  assert.equal(describeEvent(null, roster, ME), null);
});

test("errors surface in the feed", () => {
  const entry = describeEvent(
    { type: "ERROR", message: "Only the active player can fire." },
    [],
    ME
  );
  assert.equal(entry.text, "Only the active player can fire.");
  assert.equal(entry.tone, "bad");
});

test("appendFeed assigns ids, collapses repeats and caps the list", () => {
  let feed = [];
  feed = appendFeed(feed, { text: "one", tone: "info" }, 1);
  feed = appendFeed(feed, { text: "one", tone: "info" }, 2);
  assert.equal(feed.length, 1, "an immediate repeat should be collapsed");
  assert.equal(feed[0].id, 1);

  feed = appendFeed(feed, { text: "two", tone: "info" }, 3);
  assert.equal(feed.length, 2);
  assert.equal(appendFeed(feed, null, 4), feed, "nothing to append leaves the feed untouched");

  for (let i = 0; i < FEED_LIMIT + 10; i++) {
    feed = appendFeed(feed, { text: `line ${i}`, tone: "info" }, 100 + i);
  }
  assert.equal(feed.length, FEED_LIMIT, "the feed must stay bounded");
  assert.equal(feed.at(-1).text, `line ${FEED_LIMIT + 9}`, "the newest line is kept");
});

test("the summary carries robot identity, score and outcome", () => {
  const rows = buildSummary(state({ winnerId: ME }), ME);
  assert.equal(rows.length, 2);

  const [mine, bot] = rows;
  assert.equal(mine.isMe, true);
  assert.equal(mine.isWinner, true);
  assert.equal(mine.survived, true);
  assert.equal(mine.shotsFired, 3);
  assert.equal(mine.isRobot, false);

  assert.equal(bot.isRobot, true);
  assert.equal(bot.difficulty, "Hard");
  assert.equal(bot.isWinner, false);
  assert.equal(bot.survived, false);
  assert.equal(bot.shotsFired, 4);
});

test("the summary is ordered by slot regardless of input order", () => {
  const rows = buildSummary({ players: [roster[1], roster[0]], winnerId: null }, ME);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Commander", "Overlord"]
  );
});

test("the summary is empty without a match", () => {
  assert.deepEqual(buildSummary(null, ME), []);
  assert.deepEqual(buildSummary({ players: [] }, ME), []);
});

test("the outcome headline reflects who won", () => {
  assert.equal(describeOutcome(state({ winnerId: ME }), ME), "Victory");
  assert.equal(describeOutcome(state({ winnerId: BOT }), ME), "Overlord Wins");
  assert.equal(describeOutcome(state({ winnerId: null }), ME), "Draw");
  assert.equal(describeOutcome(state({ winnerId: "ghost" }), ME), "Draw");
  assert.equal(describeOutcome(null, ME), "Match Concluded");
});
