//! Pocket Artillery — SpacetimeDB module.
//!
//! This single module replaces BOTH the old PartyKit realtime server AND the
//! Supabase persistence layer. Game state lives in SpacetimeDB tables; clients
//! subscribe to them and react to row changes. All authoritative logic
//! (turns, physics, damage, terrain destruction, the robot opponent) runs here
//! as reducers.
//!
//! Ported from backend/src/handlers/{MatchHandler,PhysicsEngine}.js.
//!
//! Layout:
//! * [`sim`]   — pure ballistics/terrain/damage math (host-testable).
//! * [`robot`] — the AI opponent's pure decision making (host-testable).
//! * this file — tables, reducers, scheduling, and turn orchestration.
//!
//! The robot is a real seated `Player` row driven by scheduled reducers. It has
//! no bypass: its shots go through the same `launch_shot` that a human's
//! `fire_weapon` call does, so ammo, turn order, and physics all apply equally.

mod robot;
mod sim;

use robot::Difficulty;
use sim::Tank;
use spacetimedb::{
    reducer, table, Identity, ReducerContext, ScheduleAt, Table, TimeDuration, Timestamp,
};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const RECONNECT_GRACE_MS: i64 = 60_000;
const TURN_MS: i64 = 30_000;

/// How long the robot "thinks" before its aim appears, and how long it holds
/// that aim before firing. Purely cosmetic pacing so a human can watch the
/// barrel swing instead of being hit by an instantaneous shot.
const ROBOT_THINK_MS: i64 = 800;
const ROBOT_AIM_MS: i64 = 900;

/// How often abandoned rooms are swept, and how long a room may sit untouched
/// before it counts as abandoned. A live match bumps its activity stamp every
/// turn (at most 30s apart), so nothing playable is ever close to the cutoff.
const CLEANUP_INTERVAL_MS: i64 = 300_000;
const ROOM_IDLE_MS: i64 = 900_000;

const STARTING_HP: i32 = 100;
const AMMO_STANDARD: u32 = 99;
const AMMO_CLUSTER: u32 = 3;
const AMMO_NUKE: u32 = 1;

const PLAYER_COLORS: [&str; 2] = ["#22d3ee", "#fb7185"];
const PLAYER_NAMES: [&str; 2] = ["Alpha", "Omega"];
const ROBOT_COLOR: &str = "#a78bfa";

/// Marks the synthetic identities minted for robots. Real identities come from
/// JWT hashes, so this prefix will never collide with a human's.
const ROBOT_ID_TAG: [u8; 8] = [0xB0, 0x11, 0x0B, 0x07, 0xA1, 0xFF, 0x5E, 0xED];

const STATUS_WAITING: &str = "waiting";
const STATUS_PLAYING: &str = "playing";
const STATUS_PAUSED: &str = "paused";
const STATUS_FINISHED: &str = "finished";

const PHASE_AIM: u8 = 0;
const PHASE_FIRE: u8 = 1;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// One row per active match/room. Keyed by the human room code (e.g. "K7QF9M").
/// `terrain` holds the full heightmap; clients render it directly.
#[table(name = match_room, public)]
#[derive(Clone)]
pub struct MatchRoom {
    #[primary_key]
    pub room_code: String,
    /// "waiting" | "playing" | "paused" | "finished"
    pub status: String,
    pub active_player_slot: u8,
    pub terrain_seed: i64,
    pub wind: f32,
    pub width: u32,
    pub height: u32,
    pub winner_identity: Option<Identity>,
    pub turn_started_at: Option<Timestamp>,
    pub disconnect_deadline: Option<Timestamp>,
    /// Turn generation counter; a scheduled turn timeout only fires if its
    /// captured turn_id still matches (stale timers are no-ops).
    pub turn_id: u64,
    /// Full terrain heightmap, one entry per horizontal pixel (length == WIDTH).
    pub terrain: Vec<f32>,
    /// True for a single-human match against a robot. Solo rooms are private:
    /// nobody else can join them.
    pub solo: bool,
    /// Last time anything meaningful happened here; drives stale-room cleanup.
    /// Only bumped by writes that already touch this row, so it never causes an
    /// extra client-visible update.
    pub last_activity: Timestamp,
}

/// One row per player. Keyed by the caller's SpacetimeDB Identity, so an
/// identity can be in at most one match at a time. Robots get a synthetic
/// identity derived from the room code (see [`robot_identity_for`]).
#[table(name = player, public)]
#[derive(Clone)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub room_code: String,
    pub slot: u8,
    pub name: String,
    pub color: String,
    pub hp: i32,
    pub angle: f32,
    pub power: f32,
    pub x: f32,
    pub y: f32,
    pub connected: bool,
    pub ammo_standard: u32,
    pub ammo_cluster: u32,
    pub ammo_nuke: u32,
    /// Currently selected weapon ("standard" | "cluster" | "nuke"); used when
    /// the turn clock expires and the server auto-fires on the player's behalf,
    /// and to carry the robot's choice from its aim phase to its fire phase.
    pub selected_weapon: String,
    /// Browser-scoped id (survives identity churn across tabs); informational.
    pub client_id: String,
    /// True for AI-controlled players. Drives the "AI" badge in the UI and the
    /// scheduled turn handoff in [`begin_turn`].
    pub is_robot: bool,
    /// "easy" | "normal" | "hard" for robots; empty for humans.
    pub robot_difficulty: String,
    /// Shots taken this match, for the end-of-match summary.
    pub shots_fired: u32,
}

/// An in-flight projectile. Inserted on fire (clients animate it), deleted at
/// impact (the delete is what the client turns into a SERVER_IMPACT event).
#[table(name = projectile, public)]
#[derive(Clone)]
pub struct Projectile {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub room_code: String,
    pub player_identity: Identity,
    pub weapon_id: String,
    pub start_x: f32,
    pub start_y: f32,
    pub vx: f32,
    pub vy: f32,
    pub impact_x: f32,
    pub impact_y: f32,
    pub radius: f32,
    pub tti_ms: u64,
}

/// Scheduled one-shot: fires `process_impact` `tti_ms` after a shot is launched.
#[table(name = impact_timer, scheduled(process_impact))]
pub struct ImpactTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub room_code: String,
    pub projectile_id: u64,
}

/// Scheduled one-shot: fires `process_forfeit` after the reconnect grace window.
#[table(name = forfeit_timer, scheduled(process_forfeit))]
pub struct ForfeitTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub room_code: String,
    pub player_identity: Identity,
}

/// Scheduled one-shot: fires `process_turn_timeout` when the 30s turn clock
/// runs out. Carries the turn_id it was armed for so stale timers are ignored.
#[table(name = turn_timer, scheduled(process_turn_timeout))]
pub struct TurnTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub room_code: String,
    pub turn_id: u64,
}

/// Scheduled one-shot: drives one step of a robot's turn. `phase` is
/// PHASE_AIM (commit an aim) or PHASE_FIRE (pull the trigger). Carries the
/// turn_id it was armed for so stale timers are ignored.
#[table(name = robot_timer, scheduled(process_robot_turn))]
pub struct RobotTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub room_code: String,
    pub turn_id: u64,
    pub phase: u8,
}

/// Scheduled repeating: sweeps abandoned rooms and orphaned rows.
#[table(name = cleanup_timer, scheduled(process_room_cleanup))]
pub struct CleanupTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

// ---------------------------------------------------------------------------
// Lifecycle reducers
// ---------------------------------------------------------------------------

#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    // Guarded so a republish that keeps existing data doesn't stack up sweepers.
    if ctx.db.cleanup_timer().count() == 0 {
        ctx.db.cleanup_timer().insert(CleanupTimer {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(
                CLEANUP_INTERVAL_MS * 1000,
            )),
        });
    }
    log::info!("pocket-artillery module initialized");
}

/// A client (re)connected. If they already have a player row, mark it live.
#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender) {
        if !p.connected {
            p.connected = true;
            ctx.db.player().identity().update(p);
        }
    }
}

/// A client dropped. Mark them disconnected, pause an active match, and arm a
/// forfeit timer for the reconnect grace window.
#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    let Some(mut p) = ctx.db.player().identity().find(ctx.sender) else {
        return;
    };
    p.connected = false;
    let code = p.room_code.clone();
    ctx.db.player().identity().update(p);

    if let Some(mut room) = ctx.db.match_room().room_code().find(&code) {
        if room.status == STATUS_PLAYING {
            let deadline = plus_millis(ctx.timestamp, RECONNECT_GRACE_MS);
            room.status = STATUS_PAUSED.to_string();
            room.disconnect_deadline = Some(deadline);
            room.last_activity = ctx.timestamp;
            ctx.db.match_room().room_code().update(room);
            ctx.db.forfeit_timer().insert(ForfeitTimer {
                scheduled_id: 0,
                scheduled_at: ScheduleAt::Time(deadline),
                room_code: code,
                player_identity: ctx.sender,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Gameplay reducers (called by clients)
// ---------------------------------------------------------------------------

/// Join (or create) a multiplayer room. Creates the match on first join, seats
/// the caller, and starts the match once two players are seated.
#[reducer]
pub fn join_match(
    ctx: &ReducerContext,
    room_code: String,
    name: String,
    client_id: String,
) -> Result<(), String> {
    let code = normalize_code(&room_code);
    if code.len() < 4 {
        return Err("Invalid room code.".to_string());
    }

    // A solo room belongs to its creator and their robot; strangers stay out.
    // (The creator's own reconnect is allowed — they are already seated.)
    if let Some(existing) = ctx.db.match_room().room_code().find(&code) {
        let already_seated = ctx
            .db
            .player()
            .identity()
            .find(ctx.sender)
            .is_some_and(|p| p.room_code == code);
        if existing.solo && !already_seated {
            return Err("That room is a solo match against the robot.".to_string());
        }
    }

    ensure_room(ctx, &code, false);
    seat_caller(ctx, &code, &name, &client_id)?;
    settle_lobby(ctx, &code)
}

/// Start (or rejoin) a solo match: seats the caller, seats a robot opposite
/// them, and kicks the match off immediately — no second human required.
#[reducer]
pub fn create_solo_match(
    ctx: &ReducerContext,
    room_code: String,
    name: String,
    client_id: String,
    difficulty: String,
) -> Result<(), String> {
    let code = normalize_code(&room_code);
    if code.len() < 4 {
        return Err("Invalid room code.".to_string());
    }
    if let Some(existing) = ctx.db.match_room().room_code().find(&code) {
        if !existing.solo {
            return Err("That room is already a multiplayer match.".to_string());
        }
    }

    let level = Difficulty::from_label(&difficulty);
    ensure_room(ctx, &code, true);
    seat_caller(ctx, &code, &name, &client_id)?;
    ensure_robot(ctx, &code, level)?;
    settle_lobby(ctx, &code)
}

/// Update the caller's aim. Only meaningful while the match is playing.
#[reducer]
pub fn aim(ctx: &ReducerContext, angle: f32, power: f32) -> Result<(), String> {
    let mut player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or("Join a room before aiming.")?;
    let room = ctx
        .db
        .match_room()
        .room_code()
        .find(&player.room_code)
        .ok_or("Room no longer exists.")?;
    if room.status != STATUS_PLAYING {
        return Ok(());
    }
    player.angle = sim::clamp(angle, 0.0, 180.0);
    player.power = sim::clamp(power, 1.0, 100.0);
    ctx.db.player().identity().update(player);
    Ok(())
}

/// Fire a weapon. Validates turn + ammo, simulates the shot, inserts the
/// projectile row, and schedules the impact.
#[reducer]
pub fn fire_weapon(
    ctx: &ReducerContext,
    angle: f32,
    power: f32,
    weapon_id: String,
) -> Result<(), String> {
    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or("Join a room before firing.")?;
    let room = ctx
        .db
        .match_room()
        .room_code()
        .find(&player.room_code)
        .ok_or("Room no longer exists.")?;

    if room.status != STATUS_PLAYING {
        return Err("Cannot fire until the match is active.".to_string());
    }
    if room.active_player_slot != player.slot {
        return Err("Only the active player can fire.".to_string());
    }
    if player.hp <= 0 {
        return Err("Your tank is destroyed.".to_string());
    }
    if projectile_in_flight(ctx, &player.room_code) {
        return Err("A shot is already in flight.".to_string());
    }

    launch_shot(
        ctx,
        player,
        &room,
        angle,
        power,
        sim::normalize_weapon(&weapon_id),
    )
}

/// Remember the caller's weapon choice so a turn timeout fires the right one.
#[reducer]
pub fn select_weapon(ctx: &ReducerContext, weapon_id: String) -> Result<(), String> {
    let mut player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or("Join a room before selecting a weapon.")?;
    let next = sim::normalize_weapon(&weapon_id);
    if player.selected_weapon == next {
        return Ok(());
    }
    player.selected_weapon = next.to_string();
    ctx.db.player().identity().update(player);
    Ok(())
}

/// Update the caller's display name.
#[reducer]
pub fn rename_player(ctx: &ReducerContext, name: String) -> Result<(), String> {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender) {
        if let Some(n) = safe_name(&name) {
            if n != p.name {
                p.name = n;
                ctx.db.player().identity().update(p);
            }
        }
    }
    Ok(())
}

/// Explicitly leave the current room. Cleans up rooms nobody is left playing.
#[reducer]
pub fn leave_match(ctx: &ReducerContext) -> Result<(), String> {
    let Some(p) = ctx.db.player().identity().find(ctx.sender) else {
        return Ok(());
    };
    let code = p.room_code.clone();
    ctx.db.player().identity().delete(ctx.sender);

    // A room holding nothing but robots has no one left to play it.
    let remaining = players_in(ctx, &code);
    if remaining.iter().all(|r| r.is_robot) {
        demolish_room(ctx, &code);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scheduled reducers (fired by the SpacetimeDB scheduler, not clients)
// ---------------------------------------------------------------------------

/// Resolve an explosion once the projectile's time-to-impact elapses.
#[reducer]
pub fn process_impact(ctx: &ReducerContext, timer: ImpactTimer) -> Result<(), String> {
    scheduler_only(ctx)?;

    let Some(proj) = ctx.db.projectile().id().find(timer.projectile_id) else {
        return Ok(());
    };
    let Some(mut room) = ctx.db.match_room().room_code().find(&proj.room_code) else {
        ctx.db.projectile().id().delete(proj.id);
        return Ok(());
    };

    let w = sim::weapon(&proj.weapon_id);
    let (cx, cy) = (proj.impact_x, proj.impact_y);

    // Carve the terrain, then apply damage and reseat players onto the new
    // heightmap.
    let mut terrain = room.terrain.clone();
    sim::carve_terrain(&mut terrain, cx, cy, w.explosion_radius);

    for mut p in players_in(ctx, &proj.room_code) {
        let hit = sim::blast_damage(&w, &tank_of(&p), cx, cy);
        if hit > 0 {
            p.hp = (p.hp - hit).max(0);
        }
        p.y = sim::get_terrain_height(&terrain, p.x);
        ctx.db.player().identity().update(p);
    }

    // Resolve turn / win state.
    let players = players_in(ctx, &proj.room_code);
    let alive: Vec<&Player> = players.iter().filter(|p| p.hp > 0).collect();
    room.terrain = terrain;
    if alive.len() <= 1 {
        let winner = alive.first().map(|p| p.identity);
        finish_match(ctx, &mut room, winner);
    } else {
        advance_turn(ctx, &mut room);
    }
    ctx.db.match_room().room_code().update(room);

    // Deleting the projectile is the client's cue to render the explosion.
    ctx.db.projectile().id().delete(proj.id);
    Ok(())
}

/// Auto-fire for the active player once the 30s turn clock expires.
#[reducer]
pub fn process_turn_timeout(ctx: &ReducerContext, timer: TurnTimer) -> Result<(), String> {
    scheduler_only(ctx)?;

    let Some(mut room) = ctx.db.match_room().room_code().find(&timer.room_code) else {
        return Ok(());
    };
    // Stale timer: the turn already ended (shot resolved, pause, match over).
    if room.status != STATUS_PLAYING || room.turn_id != timer.turn_id {
        return Ok(());
    }
    // The player fired at the buzzer; the in-flight shot will resolve the turn.
    if projectile_in_flight(ctx, &timer.room_code) {
        return Ok(());
    }
    let Some(player) = active_player(ctx, &room) else {
        return Ok(());
    };

    // Fire their current aim; fall back to standard if the pick is out of ammo.
    let mut wid = sim::normalize_weapon(&player.selected_weapon);
    if ammo_for(&player, wid) == 0 {
        wid = sim::WEAPON_STANDARD;
    }
    if ammo_for(&player, wid) == 0 {
        // Nothing left to fire — pass the turn instead.
        log::info!(
            "room={} slot={} timed out with no ammo; passing the turn",
            timer.room_code,
            player.slot
        );
        advance_turn(ctx, &mut room);
        ctx.db.match_room().room_code().update(room);
        return Ok(());
    }

    log::info!(
        "room={} slot={} turn expired; auto-firing {wid}",
        timer.room_code,
        player.slot
    );
    let (angle, power) = (player.angle, player.power);
    launch_shot(ctx, player, &room, angle, power, wid)
}

/// Drive one step of a robot's turn: commit an aim, then fire it.
///
/// Split into two scheduled steps so the human sees the barrel move before the
/// shot goes out. Both steps re-validate against the live room, so a stale
/// timer (turn already over, match paused, human quit) is a no-op.
#[reducer]
pub fn process_robot_turn(ctx: &ReducerContext, timer: RobotTimer) -> Result<(), String> {
    scheduler_only(ctx)?;

    let Some(mut room) = ctx.db.match_room().room_code().find(&timer.room_code) else {
        return Ok(());
    };
    if room.status != STATUS_PLAYING || room.turn_id != timer.turn_id {
        return Ok(()); // stale: the turn moved on without us
    }
    if projectile_in_flight(ctx, &timer.room_code) {
        return Ok(());
    }
    let Some(bot) = active_player(ctx, &room).filter(|p| p.is_robot) else {
        return Ok(());
    };

    if timer.phase == PHASE_AIM {
        return robot_take_aim(ctx, &mut room, bot);
    }

    // PHASE_FIRE: shoot the aim committed in the previous step. Reading it back
    // off the row means the robot fires exactly what the client already saw.
    let wid = sim::normalize_weapon(&bot.selected_weapon);
    if ammo_for(&bot, wid) == 0 {
        log::warn!(
            "robot room={} lost its {wid} ammo mid-turn; passing",
            timer.room_code
        );
        advance_turn(ctx, &mut room);
        ctx.db.match_room().room_code().update(room);
        return Ok(());
    }
    let (angle, power) = (bot.angle, bot.power);
    launch_shot(ctx, bot, &room, angle, power, wid)
}

/// Award the match to the remaining player if their opponent never reconnects.
#[reducer]
pub fn process_forfeit(ctx: &ReducerContext, timer: ForfeitTimer) -> Result<(), String> {
    scheduler_only(ctx)?;

    let Some(mut room) = ctx.db.match_room().room_code().find(&timer.room_code) else {
        return Ok(());
    };
    if room.status != STATUS_PAUSED {
        return Ok(());
    }
    let Some(dropped) = ctx.db.player().identity().find(timer.player_identity) else {
        return Ok(());
    };
    if dropped.connected {
        return Ok(());
    }

    let opponent = players_in(ctx, &timer.room_code)
        .into_iter()
        .find(|p| p.identity != timer.player_identity && p.hp > 0);

    log::info!(
        "room={} forfeited by slot={} after the reconnect window",
        timer.room_code,
        dropped.slot
    );
    finish_match(ctx, &mut room, opponent.map(|p| p.identity));
    ctx.db.match_room().room_code().update(room);
    Ok(())
}

/// Sweep rooms nobody came back to, plus any rows orphaned behind them.
///
/// "Abandoned" needs both halves: gone quiet **and** nobody connected. A host
/// can sit in a lobby for an hour waiting for a friend without the room being
/// swept out from under them, and a robot (always flagged connected) never keeps
/// a room alive on its own.
#[reducer]
pub fn process_room_cleanup(ctx: &ReducerContext, _timer: CleanupTimer) -> Result<(), String> {
    scheduler_only(ctx)?;

    let cutoff = ctx.timestamp.to_micros_since_unix_epoch() - ROOM_IDLE_MS * 1000;
    let stale: Vec<String> = ctx
        .db
        .match_room()
        .iter()
        .filter(|r| r.last_activity.to_micros_since_unix_epoch() < cutoff)
        .filter(|r| {
            !players_in(ctx, &r.room_code)
                .iter()
                .any(|p| p.connected && !p.is_robot)
        })
        .map(|r| r.room_code.clone())
        .collect();

    for code in &stale {
        log::info!("sweeping abandoned room={code}");
        demolish_room(ctx, code);
    }

    // Rows whose room vanished some other way (crash, manual delete).
    let orphan_players: Vec<Identity> = ctx
        .db
        .player()
        .iter()
        .filter(|p| ctx.db.match_room().room_code().find(&p.room_code).is_none())
        .map(|p| p.identity)
        .collect();
    for identity in orphan_players {
        ctx.db.player().identity().delete(identity);
    }

    let orphan_shots: Vec<u64> = ctx
        .db
        .projectile()
        .iter()
        .filter(|p| ctx.db.match_room().room_code().find(&p.room_code).is_none())
        .map(|p| p.id)
        .collect();
    for id in orphan_shots {
        ctx.db.projectile().id().delete(id);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Robot orchestration
// ---------------------------------------------------------------------------

/// Seat a robot opposite the human if the room doesn't have one yet.
fn ensure_robot(ctx: &ReducerContext, code: &str, level: Difficulty) -> Result<(), String> {
    let seated = players_in(ctx, code);
    if seated.iter().any(|p| p.is_robot) {
        return Ok(());
    }
    let slot = free_slot(&seated).ok_or("This match already has two players.")?;
    let identity = robot_identity_for(code);

    // Defensive: a previous robot row for this identity (different room, or a
    // room that was torn down mid-write) must not block the insert.
    if ctx.db.player().identity().find(identity).is_some() {
        ctx.db.player().identity().delete(identity);
    }

    let mut row = new_player_row(identity, code, slot, level.display_name().to_string());
    row.is_robot = true;
    row.robot_difficulty = level.as_label().to_string();
    row.color = ROBOT_COLOR.to_string();
    ctx.db.player().insert(row);

    log::info!(
        "room={code} seated robot '{}' ({}) in slot {slot}",
        level.display_name(),
        level.as_label()
    );
    Ok(())
}

/// The robot's aim step: search for a shot, commit it to its player row (which
/// is what a human dragging the sliders does), and schedule the trigger pull.
fn robot_take_aim(ctx: &ReducerContext, room: &mut MatchRoom, bot: Player) -> Result<(), String> {
    let players = players_in(ctx, &room.room_code);
    let Some(target) = players
        .iter()
        .find(|p| p.slot != bot.slot && p.hp > 0)
        .cloned()
    else {
        return Ok(()); // no one left to shoot at; the impact handler ends it
    };

    let ammo = robot::Ammo {
        standard: bot.ammo_standard,
        cluster: bot.ammo_cluster,
        nuke: bot.ammo_nuke,
    };
    if ammo.is_empty() {
        log::info!(
            "robot room={} is out of shells; passing the turn",
            room.room_code
        );
        advance_turn(ctx, room);
        ctx.db.match_room().room_code().update(room.clone());
        return Ok(());
    }

    let tanks: Vec<Tank> = players.iter().map(tank_of).collect();
    let level = Difficulty::from_label(&bot.robot_difficulty);
    let field = robot::Battlefield {
        shooter: tank_of(&bot),
        target: tank_of(&target),
        ammo,
        terrain: &room.terrain,
        tanks: &tanks,
        wind: room.wind,
    };

    let Some(plan) = robot::plan_shot(&field, level, robot_seed(room)) else {
        log::warn!(
            "robot room={} could not find a shot; passing the turn",
            room.room_code
        );
        advance_turn(ctx, room);
        ctx.db.match_room().room_code().update(room.clone());
        return Ok(());
    };

    log::info!(
        "robot room={} turn={} level={} weapon={} angle={:.1} power={:.1} \
         predicts ({:.0},{:.0}) miss={:.1}px hit={}",
        room.room_code,
        room.turn_id,
        level.as_label(),
        plan.weapon_id,
        plan.angle,
        plan.power,
        plan.predicted_x,
        plan.predicted_y,
        plan.miss_distance,
        plan.expects_hit
    );

    let mut aiming = bot;
    aiming.angle = plan.angle;
    aiming.power = plan.power;
    aiming.selected_weapon = plan.weapon_id.to_string();
    ctx.db.player().identity().update(aiming);

    ctx.db.robot_timer().insert(RobotTimer {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(plus_millis(ctx.timestamp, ROBOT_AIM_MS)),
        room_code: room.room_code.clone(),
        turn_id: room.turn_id,
        phase: PHASE_FIRE,
    });
    Ok(())
}

/// Deterministic per-turn seed for the robot's aim error, so replaying a turn
/// reproduces the same "mistake".
fn robot_seed(room: &MatchRoom) -> u64 {
    (room.terrain_seed as u64) ^ room.turn_id.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

// ---------------------------------------------------------------------------
// Room / seating helpers
// ---------------------------------------------------------------------------

/// Find the room or create it in the waiting state.
fn ensure_room(ctx: &ReducerContext, code: &str, solo: bool) -> MatchRoom {
    if let Some(room) = ctx.db.match_room().room_code().find(code.to_string()) {
        return room;
    }
    ctx.db.match_room().insert(MatchRoom {
        room_code: code.to_string(),
        status: STATUS_WAITING.to_string(),
        active_player_slot: 0,
        terrain_seed: seed_from(ctx.timestamp),
        wind: 0.0,
        width: sim::WIDTH as u32,
        height: sim::HEIGHT as u32,
        winner_identity: None,
        turn_started_at: None,
        disconnect_deadline: None,
        turn_id: 0,
        terrain: Vec::new(),
        solo,
        last_activity: ctx.timestamp,
    })
}

/// Seat `ctx.sender` in `code`: reconnect, switch rooms, or take a fresh seat.
fn seat_caller(
    ctx: &ReducerContext,
    code: &str,
    name: &str,
    client_id: &str,
) -> Result<(), String> {
    match ctx.db.player().identity().find(ctx.sender) {
        Some(mut p) if p.room_code == code => {
            p.connected = true;
            if let Some(n) = safe_name(name) {
                p.name = n;
            }
            p.client_id = client_id.to_string();
            ctx.db.player().identity().update(p);
            Ok(())
        }
        Some(previous) => {
            // Player is in a different room — leave it, then take a new seat.
            let old_code = previous.room_code.clone();
            ctx.db.player().identity().delete(ctx.sender);
            if players_in(ctx, &old_code).iter().all(|r| r.is_robot) {
                demolish_room(ctx, &old_code);
            }
            seat_new_player(ctx, code, name, client_id)
        }
        None => seat_new_player(ctx, code, name, client_id),
    }
}

fn seat_new_player(
    ctx: &ReducerContext,
    code: &str,
    name: &str,
    client_id: &str,
) -> Result<(), String> {
    let seated = players_in(ctx, code);
    let slot = free_slot(&seated).ok_or("This match already has two players.")?;
    let display = safe_name(name).unwrap_or_else(|| default_name(slot));
    let mut row = new_player_row(ctx.sender, code, slot, display);
    row.client_id = client_id.to_string();
    ctx.db.player().insert(row);
    Ok(())
}

fn new_player_row(identity: Identity, code: &str, slot: u8, name: String) -> Player {
    Player {
        identity,
        room_code: code.to_string(),
        slot,
        name,
        color: color_for(slot),
        hp: STARTING_HP,
        angle: if slot == 0 { 45.0 } else { 135.0 },
        power: 60.0,
        x: if slot == 0 { 200.0 } else { 1000.0 },
        y: 0.0,
        connected: true,
        ammo_standard: AMMO_STANDARD,
        ammo_cluster: AMMO_CLUSTER,
        ammo_nuke: AMMO_NUKE,
        selected_weapon: sim::WEAPON_STANDARD.to_string(),
        client_id: String::new(),
        is_robot: false,
        robot_difficulty: String::new(),
        shots_fired: 0,
    }
}

fn free_slot(seated: &[Player]) -> Option<u8> {
    (0u8..2).find(|slot| !seated.iter().any(|p| p.slot == *slot))
}

/// Resume a paused match or start a full one. Shared by the multiplayer join
/// and solo-create paths so both reach "playing" the same way.
fn settle_lobby(ctx: &ReducerContext, code: &str) -> Result<(), String> {
    let Some(mut room) = ctx.db.match_room().room_code().find(code.to_string()) else {
        return Ok(());
    };
    let seated = players_in(ctx, code);
    let connected = seated.iter().filter(|p| p.connected).count();

    if room.status == STATUS_PAUSED && connected >= 2 {
        room.status = STATUS_PLAYING.to_string();
        room.disconnect_deadline = None;
        room.last_activity = ctx.timestamp;
        // Restart the active player's turn clock — unless a shot is mid-air,
        // in which case its impact will begin the next turn.
        if !projectile_in_flight(ctx, code) {
            begin_turn(ctx, &mut room);
        }
        ctx.db.match_room().room_code().update(room);
        log::info!("room={code} resumed");
        return Ok(());
    }

    if room.status == STATUS_WAITING && seated.len() == 2 && connected == 2 {
        return start_match(ctx, code);
    }
    Ok(())
}

fn start_match(ctx: &ReducerContext, code: &str) -> Result<(), String> {
    let mut room = ctx
        .db
        .match_room()
        .room_code()
        .find(code.to_string())
        .ok_or("Room not found.")?;
    let terrain = sim::generate_terrain(room.terrain_seed);

    for mut p in players_in(ctx, code) {
        p.y = sim::get_terrain_height(&terrain, p.x);
        ctx.db.player().identity().update(p);
    }

    room.terrain = terrain;
    room.status = STATUS_PLAYING.to_string();
    room.active_player_slot = 0;
    room.disconnect_deadline = None;
    room.winner_identity = None;
    begin_turn(ctx, &mut room);
    ctx.db.match_room().room_code().update(room);
    log::info!("room={code} match started");
    Ok(())
}

/// Delete a room and everything belonging to it.
fn demolish_room(ctx: &ReducerContext, code: &str) {
    for p in players_in(ctx, code) {
        ctx.db.player().identity().delete(p.identity);
    }
    let shots: Vec<u64> = ctx
        .db
        .projectile()
        .iter()
        .filter(|p| p.room_code == code)
        .map(|p| p.id)
        .collect();
    for id in shots {
        ctx.db.projectile().id().delete(id);
    }
    ctx.db.match_room().room_code().delete(code.to_string());
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

/// Start a fresh turn clock: bump the turn generation, stamp the start time,
/// arm the auto-fire timeout, and hand off to the robot brain if the turn
/// belongs to one. Mutates `room`; the caller commits it.
fn begin_turn(ctx: &ReducerContext, room: &mut MatchRoom) {
    room.turn_id += 1;
    room.turn_started_at = Some(ctx.timestamp);
    room.last_activity = ctx.timestamp;
    ctx.db.turn_timer().insert(TurnTimer {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(plus_millis(ctx.timestamp, TURN_MS)),
        room_code: room.room_code.clone(),
        turn_id: room.turn_id,
    });

    let robot_turn = players_in(ctx, &room.room_code)
        .into_iter()
        .any(|p| p.slot == room.active_player_slot && p.is_robot && p.hp > 0);
    if robot_turn {
        ctx.db.robot_timer().insert(RobotTimer {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(plus_millis(ctx.timestamp, ROBOT_THINK_MS)),
            room_code: room.room_code.clone(),
            turn_id: room.turn_id,
            phase: PHASE_AIM,
        });
    }
}

/// Hand the turn to the next living player and start their clock.
fn advance_turn(ctx: &ReducerContext, room: &mut MatchRoom) {
    let players = players_in(ctx, &room.room_code);
    room.active_player_slot = next_living_slot(room.active_player_slot, &players);
    begin_turn(ctx, room);
}

/// Close the match out. `winner` is `None` for a draw.
fn finish_match(ctx: &ReducerContext, room: &mut MatchRoom, winner: Option<Identity>) {
    room.status = STATUS_FINISHED.to_string();
    room.winner_identity = winner;
    room.turn_started_at = None;
    room.disconnect_deadline = None;
    room.last_activity = ctx.timestamp;
    log::info!(
        "room={} finished (winner: {})",
        room.room_code,
        winner
            .map(|w| w.to_hex().to_string())
            .unwrap_or_else(|| "draw".to_string())
    );
}

/// Deduct ammo, commit the shot's aim, simulate the arc, insert the projectile
/// row, and schedule its impact. Shared by `fire_weapon` (manual),
/// `process_turn_timeout` (auto-fire) and `process_robot_turn` (AI), so the
/// shooter comes from `player`, not `ctx.sender`.
fn launch_shot(
    ctx: &ReducerContext,
    mut player: Player,
    room: &MatchRoom,
    angle: f32,
    power: f32,
    wid: &'static str,
) -> Result<(), String> {
    if ammo_for(&player, wid) == 0 {
        return Err(format!("No ammo remaining for {wid}."));
    }

    match wid {
        sim::WEAPON_CLUSTER => player.ammo_cluster -= 1,
        sim::WEAPON_NUKE => player.ammo_nuke -= 1,
        _ => player.ammo_standard -= 1,
    }
    let angle = sim::clamp(angle, 0.0, 180.0);
    let power = sim::clamp(power, 1.0, 100.0);
    player.angle = angle;
    player.power = power;
    player.selected_weapon = wid.to_string();
    player.shots_fired += 1;
    ctx.db.player().identity().update(player.clone());

    let tanks: Vec<Tank> = players_in(ctx, &player.room_code)
        .iter()
        .map(tank_of)
        .collect();
    let w = sim::weapon(wid);
    let shot = sim::simulate_projectile(
        &tank_of(&player),
        &room.terrain,
        &tanks,
        angle,
        power,
        room.wind,
    );

    let proj = ctx.db.projectile().insert(Projectile {
        id: 0,
        room_code: player.room_code.clone(),
        player_identity: player.identity,
        weapon_id: wid.to_string(),
        start_x: shot.start_x,
        start_y: shot.start_y,
        vx: shot.vx,
        vy: shot.vy,
        impact_x: shot.impact_x,
        impact_y: shot.impact_y,
        radius: w.explosion_radius,
        tti_ms: shot.tti_ms,
    });

    ctx.db.impact_timer().insert(ImpactTimer {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(plus_millis(ctx.timestamp, shot.tti_ms as i64)),
        room_code: player.room_code.clone(),
        projectile_id: proj.id,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Scheduled reducers are public API surface; reject direct client calls.
fn scheduler_only(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("Scheduled reducers cannot be called by clients.".to_string());
    }
    Ok(())
}

fn active_player(ctx: &ReducerContext, room: &MatchRoom) -> Option<Player> {
    players_in(ctx, &room.room_code)
        .into_iter()
        .find(|p| p.slot == room.active_player_slot && p.hp > 0)
}

fn projectile_in_flight(ctx: &ReducerContext, code: &str) -> bool {
    ctx.db.projectile().iter().any(|p| p.room_code == code)
}

fn players_in(ctx: &ReducerContext, code: &str) -> Vec<Player> {
    let mut players: Vec<Player> = ctx
        .db
        .player()
        .iter()
        .filter(|p| p.room_code == code)
        .collect();
    players.sort_by_key(|p| p.slot);
    players
}

fn tank_of(p: &Player) -> Tank {
    Tank::new(p.x, p.y, p.hp)
}

fn ammo_for(p: &Player, wid: &str) -> u32 {
    match sim::normalize_weapon(wid) {
        sim::WEAPON_CLUSTER => p.ammo_cluster,
        sim::WEAPON_NUKE => p.ammo_nuke,
        _ => p.ammo_standard,
    }
}

fn next_living_slot(current: u8, players: &[Player]) -> u8 {
    let max_slot = players.iter().map(|p| p.slot).max().unwrap_or(current);
    let modulo = max_slot as u16 + 1;
    for off in 1..=modulo {
        let cand = ((current as u16 + off) % modulo) as u8;
        if players.iter().any(|p| p.slot == cand && p.hp > 0) {
            return cand;
        }
    }
    current
}

/// Stable synthetic identity for a room's robot, so reconnects and republishes
/// keep talking about the same tank.
fn robot_identity_for(code: &str) -> Identity {
    let a = fnv1a64(code.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let b = fnv1a64(code.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let mut bytes = [0u8; 32];
    bytes[0..8].copy_from_slice(&ROBOT_ID_TAG);
    bytes[8..16].copy_from_slice(&a.to_le_bytes());
    bytes[16..24].copy_from_slice(&b.to_le_bytes());
    bytes[24..32].copy_from_slice(&(a ^ b).to_le_bytes());
    Identity::from_byte_array(bytes)
}

fn fnv1a64(bytes: &[u8], basis: u64) -> u64 {
    let mut hash = basis;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Deterministic terrain seed derived from the room's creation timestamp.
fn seed_from(ts: Timestamp) -> i64 {
    let micros = ts.to_micros_since_unix_epoch();
    (micros % (i32::MAX as i64)).abs().max(1)
}

fn plus_millis(ts: Timestamp, ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ts.to_micros_since_unix_epoch() + ms * 1000)
}

fn normalize_code(raw: &str) -> String {
    raw.trim()
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect()
}

fn safe_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(24).collect())
    }
}

fn default_name(slot: u8) -> String {
    PLAYER_NAMES
        .get(slot as usize)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Player {}", slot + 1))
}

fn color_for(slot: u8) -> String {
    PLAYER_COLORS
        .get(slot as usize)
        .unwrap_or(&"#94a3b8")
        .to_string()
}
