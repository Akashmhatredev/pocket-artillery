// Turns the server event stream into human-readable activity-feed lines and an
// end-of-match summary.
//
// Kept as pure functions (no React, no DOM) so both the UI and the unit tests
// in tests/unit can use them.

export const FEED_LIMIT = 40;

const WEAPON_LABELS = {
  standard: "Standard Shell",
  cluster: "Cluster Bomb",
  nuke: "Mini Nuke",
};

export function weaponLabel(weaponId) {
  return WEAPON_LABELS[weaponId] ?? WEAPON_LABELS.standard;
}

export function difficultyLabel(difficulty) {
  if (!difficulty) return null;
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
}

function findPlayer(players, playerId) {
  if (!playerId) return null;
  return players.find((player) => player.id === playerId) ?? null;
}

function nameOf(players, playerId, fallback = "Unknown") {
  return findPlayer(players, playerId)?.name ?? fallback;
}

/**
 * Describe one server event for the activity feed.
 *
 * @param event    the event as emitted by MultiplayerConnection
 * @param players  players from the freshest state we have
 * @param myPlayerId the local player's id, used to colour the line
 * @returns `{ text, tone, robot }` or `null` when the event is not worth showing
 */
export function describeEvent(event, players = [], myPlayerId = null) {
  if (!event) return null;
  const roster = event.state?.players ?? players;

  switch (event.type) {
    case "MATCH_START": {
      const names = roster.map((player) => player.name).join(" vs ");
      return { text: names ? `Battle joined — ${names}` : "Battle joined", tone: "info" };
    }

    case "TURN_START": {
      const player = findPlayer(roster, event.playerId);
      if (!player) return null;
      const mine = player.id === myPlayerId;
      return {
        text: mine ? "Your turn — take the shot" : `${player.name} is taking aim`,
        tone: mine ? "good" : "info",
        robot: player.isRobot === true,
      };
    }

    case "SERVER_PROJECTILE_SPAWNED":
    case "PROJECTILE_SPAWNED": {
      const player = findPlayer(roster, event.playerId);
      const who = player ? player.name : "Someone";
      return {
        text: `${who} fired a ${weaponLabel(event.weaponId)}`,
        tone: player?.id === myPlayerId ? "good" : "info",
        robot: player?.isRobot === true,
      };
    }

    case "SERVER_IMPACT":
    case "IMPACT": {
      const hits = event.damage ?? [];
      if (hits.length === 0) {
        return { text: `${weaponLabel(event.weaponId)} missed`, tone: "warn" };
      }
      const parts = hits.map((hit) => {
        const target = findPlayer(roster, hit.playerId);
        const label = hit.playerId === myPlayerId ? "you" : (target?.name ?? hit.name ?? "target");
        return `${label} for ${hit.amount}`;
      });
      const hurtMe = hits.some((hit) => hit.playerId === myPlayerId);
      return {
        text: `${weaponLabel(event.weaponId)} hit ${parts.join(" and ")}`,
        tone: hurtMe ? "bad" : "good",
      };
    }

    case "MATCH_END": {
      const winner = findPlayer(roster, event.winnerId);
      if (!winner) return { text: "Match over — draw", tone: "warn" };
      const mine = winner.id === myPlayerId;
      return {
        text: mine ? "Match over — you win" : `Match over — ${winner.name} wins`,
        tone: mine ? "good" : "bad",
        robot: winner.isRobot === true,
      };
    }

    case "ERROR":
      return event.message ? { text: event.message, tone: "bad" } : null;

    default:
      return null;
  }
}

/**
 * Append an entry, collapsing an immediate repeat of the same line and capping
 * the list so a long match cannot grow the feed without bound.
 */
export function appendFeed(feed, entry, nextId) {
  if (!entry) return feed;
  const last = feed[feed.length - 1];
  if (last && last.text === entry.text) return feed;
  const next = [...feed, { ...entry, id: nextId }];
  return next.length > FEED_LIMIT ? next.slice(next.length - FEED_LIMIT) : next;
}

/**
 * Rows for the end-of-match scoreboard. Works for humans and robots alike.
 */
export function buildSummary(state, myPlayerId = null) {
  if (!state?.players?.length) return [];
  return [...state.players]
    .sort((a, b) => a.slot - b.slot)
    .map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      hp: player.hp,
      shotsFired: player.shotsFired ?? 0,
      isRobot: player.isRobot === true,
      difficulty: difficultyLabel(player.robotDifficulty),
      isMe: player.id === myPlayerId,
      isWinner: !!state.winnerId && state.winnerId === player.id,
      survived: player.hp > 0,
    }));
}

/** Headline for the end-of-match card. */
export function describeOutcome(state, myPlayerId = null) {
  if (!state) return "Match Concluded";
  if (!state.winnerId) return "Draw";
  const winner = state.players?.find((player) => player.id === state.winnerId);
  if (!winner) return "Draw";
  if (winner.id === myPlayerId) return "Victory";
  return `${winner.name} Wins`;
}
