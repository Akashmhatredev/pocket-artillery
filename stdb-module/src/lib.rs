//! Pocket Artillery — SpacetimeDB module.
//!
//! This single module replaces BOTH the old PartyKit realtime server AND the
//! Supabase persistence layer. Game state lives in SpacetimeDB tables; clients
//! subscribe to them and react to row changes. All authoritative logic
//! (turns, physics, damage, terrain destruction) runs here as reducers.
//!
//! Ported from backend/src/handlers/{MatchHandler,PhysicsEngine}.js.

use core::f32::consts::PI;
use spacetimedb::{reducer, table, Identity, ReducerContext, ScheduleAt, Table, Timestamp};

// ---------------------------------------------------------------------------
// World constants (mirrors WORLD in PhysicsEngine.js)
// ---------------------------------------------------------------------------

const WIDTH: usize = 1200;
const HEIGHT: usize = 800;
const GRAVITY: f32 = 0.2;
const MAX_TICKS: u64 = 1800;
const TICK_MS: u64 = 16;
const RECONNECT_GRACE_MS: i64 = 60_000;

const PLAYER_COLORS: [&str; 2] = ["#22d3ee", "#fb7185"];
const PLAYER_NAMES: [&str; 2] = ["Alpha", "Omega"];

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
    /// Full terrain heightmap, one entry per horizontal pixel (length == WIDTH).
    pub terrain: Vec<f32>,
}

/// One row per player. Keyed by the caller's SpacetimeDB Identity, so an
/// identity can be in at most one match at a time.
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
    /// Browser-scoped id (survives identity churn across tabs); informational.
    pub client_id: String,
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

// ---------------------------------------------------------------------------
// Lifecycle reducers
// ---------------------------------------------------------------------------

#[reducer(init)]
pub fn init(_ctx: &ReducerContext) {
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
        if room.status == "playing" {
            let deadline = plus_millis(ctx.timestamp, RECONNECT_GRACE_MS);
            room.status = "paused".to_string();
            room.disconnect_deadline = Some(deadline);
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

/// Join (or create) a room. Creates the match on first join, seats the caller,
/// and starts the match once two players are seated.
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

    // Ensure the room exists.
    let mut room = match ctx.db.match_room().room_code().find(&code) {
        Some(r) => r,
        None => {
            let seed = seed_from(ctx.timestamp);
            ctx.db.match_room().insert(MatchRoom {
                room_code: code.clone(),
                status: "waiting".to_string(),
                active_player_slot: 0,
                terrain_seed: seed,
                wind: 0.0,
                width: WIDTH as u32,
                height: HEIGHT as u32,
                winner_identity: None,
                turn_started_at: None,
                disconnect_deadline: None,
                terrain: Vec::new(),
            })
        }
    };

    // Seat the caller (reconnect, room switch, or brand-new seat).
    match ctx.db.player().identity().find(ctx.sender) {
        Some(mut p) if p.room_code == code => {
            p.connected = true;
            if let Some(n) = safe_name(&name) {
                p.name = n;
            }
            p.client_id = client_id;
            ctx.db.player().identity().update(p);
        }
        Some(_) => {
            // Player is in a different room — leave it, then take a new seat.
            ctx.db.player().identity().delete(ctx.sender);
            seat_new_player(ctx, &code, &name, &client_id)?;
        }
        None => {
            seat_new_player(ctx, &code, &name, &client_id)?;
        }
    }

    let seated: Vec<Player> = players_in(ctx, &code);
    let connected = seated.iter().filter(|p| p.connected).count();

    // Resume a paused match once both players are back.
    if room.status == "paused" && connected >= 2 {
        room.status = "playing".to_string();
        room.disconnect_deadline = None;
        ctx.db.match_room().room_code().update(room.clone());
    }

    // Kick off a fresh match once two players are seated and present.
    if room.status == "waiting" && seated.len() == 2 && connected == 2 {
        start_match(ctx, &code)?;
    }

    Ok(())
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
    if room.status != "playing" {
        return Ok(());
    }
    player.angle = clamp(angle, 0.0, 180.0);
    player.power = clamp(power, 1.0, 100.0);
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
    let mut player = ctx
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

    if room.status != "playing" {
        return Err("Cannot fire until the match is active.".to_string());
    }
    if room.active_player_slot != player.slot {
        return Err("Only the active player can fire.".to_string());
    }

    let wid = normalize_weapon(&weapon_id);
    let ammo = match wid {
        "cluster" => player.ammo_cluster,
        "nuke" => player.ammo_nuke,
        _ => player.ammo_standard,
    };
    if ammo == 0 {
        return Err(format!("No ammo remaining for {wid}."));
    }

    // Deduct ammo and commit the shot's aim.
    match wid {
        "cluster" => player.ammo_cluster -= 1,
        "nuke" => player.ammo_nuke -= 1,
        _ => player.ammo_standard -= 1,
    }
    let angle = clamp(angle, 0.0, 180.0);
    let power = clamp(power, 1.0, 100.0);
    player.angle = angle;
    player.power = power;
    ctx.db.player().identity().update(player.clone());

    let players = players_in(ctx, &player.room_code);
    let w = weapon(wid);
    let sim = simulate_projectile(&player, &room.terrain, &players, angle, power, room.wind);

    let proj = ctx.db.projectile().insert(Projectile {
        id: 0,
        room_code: player.room_code.clone(),
        player_identity: ctx.sender,
        weapon_id: wid.to_string(),
        start_x: sim.start_x,
        start_y: sim.start_y,
        vx: sim.vx,
        vy: sim.vy,
        impact_x: sim.impact_x,
        impact_y: sim.impact_y,
        radius: w.explosion_radius,
        tti_ms: sim.tti_ms,
    });

    ctx.db.impact_timer().insert(ImpactTimer {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(plus_millis(ctx.timestamp, sim.tti_ms as i64)),
        room_code: player.room_code.clone(),
        projectile_id: proj.id,
    });

    Ok(())
}

/// Update the caller's display name.
#[reducer]
pub fn rename_player(ctx: &ReducerContext, name: String) -> Result<(), String> {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender) {
        if let Some(n) = safe_name(&name) {
            p.name = n;
            ctx.db.player().identity().update(p);
        }
    }
    Ok(())
}

/// Explicitly leave the current room. Cleans up an empty room.
#[reducer]
pub fn leave_match(ctx: &ReducerContext) -> Result<(), String> {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender) {
        let code = p.room_code.clone();
        ctx.db.player().identity().delete(ctx.sender);
        if players_in(ctx, &code).is_empty() {
            ctx.db.match_room().room_code().delete(&code);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scheduled reducers (fired by the SpacetimeDB scheduler, not clients)
// ---------------------------------------------------------------------------

/// Resolve an explosion once the projectile's time-to-impact elapses.
#[reducer]
pub fn process_impact(ctx: &ReducerContext, timer: ImpactTimer) -> Result<(), String> {
    // Only the scheduler (module identity) may invoke scheduled reducers.
    if ctx.sender != ctx.identity() {
        return Err("Scheduled reducers cannot be called by clients.".to_string());
    }

    let Some(proj) = ctx.db.projectile().id().find(timer.projectile_id) else {
        return Ok(());
    };
    let Some(mut room) = ctx.db.match_room().room_code().find(&proj.room_code) else {
        ctx.db.projectile().id().delete(proj.id);
        return Ok(());
    };

    let w = weapon(&proj.weapon_id);
    let (cx, cy) = (proj.impact_x, proj.impact_y);

    // Carve the terrain (raise heights inside the blast circle).
    let mut terrain = room.terrain.clone();
    if !terrain.is_empty() {
        let from_x = (cx - w.explosion_radius).floor().max(0.0) as usize;
        let to_x = (cx + w.explosion_radius)
            .floor()
            .min((WIDTH - 1) as f32)
            .max(0.0) as usize;
        for (x, cell) in terrain.iter_mut().enumerate().take(to_x + 1).skip(from_x) {
            let dx = x as f32 - cx;
            let dy = (w.explosion_radius * w.explosion_radius - dx * dx).max(0.0).sqrt();
            if *cell < cy + dy {
                *cell = round2((cy + dy).min(HEIGHT as f32));
            }
        }
    }

    // Apply damage and reseat players onto the modified terrain.
    for mut p in players_in(ctx, &proj.room_code) {
        let dist = ((p.x - cx).powi(2) + ((p.y - 8.0) - cy).powi(2)).sqrt();
        if dist < w.explosion_radius + 15.0 {
            let falloff = (1.0 - dist / (w.explosion_radius + 15.0)).max(0.1);
            let applied = (w.damage * falloff).floor() as i32;
            p.hp = (p.hp - applied).max(0);
        }
        p.y = get_terrain_height(&terrain, p.x);
        ctx.db.player().identity().update(p);
    }

    // Resolve turn / win state.
    let players = players_in(ctx, &proj.room_code);
    let alive: Vec<&Player> = players.iter().filter(|p| p.hp > 0).collect();
    room.terrain = terrain;
    if alive.len() <= 1 {
        room.status = "finished".to_string();
        room.winner_identity = alive.first().map(|p| p.identity);
        room.turn_started_at = None;
    } else {
        room.active_player_slot = next_living_slot(room.active_player_slot, &players);
        room.turn_started_at = Some(ctx.timestamp);
    }
    ctx.db.match_room().room_code().update(room);

    // Deleting the projectile is the client's cue to render the explosion.
    ctx.db.projectile().id().delete(proj.id);
    Ok(())
}

/// Award the match to the remaining player if their opponent never reconnects.
#[reducer]
pub fn process_forfeit(ctx: &ReducerContext, timer: ForfeitTimer) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("Scheduled reducers cannot be called by clients.".to_string());
    }

    let Some(mut room) = ctx.db.match_room().room_code().find(&timer.room_code) else {
        return Ok(());
    };
    if room.status != "paused" {
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

    room.status = "finished".to_string();
    room.winner_identity = opponent.map(|p| p.identity);
    room.turn_started_at = None;
    room.disconnect_deadline = None;
    ctx.db.match_room().room_code().update(room);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn seat_new_player(
    ctx: &ReducerContext,
    code: &str,
    name: &str,
    client_id: &str,
) -> Result<(), String> {
    let seated = players_in(ctx, code);
    if seated.len() >= 2 {
        return Err("This match already has two players.".to_string());
    }
    let taken: Vec<u8> = seated.iter().map(|p| p.slot).collect();
    let slot: u8 = if !taken.contains(&0) { 0 } else { 1 };

    ctx.db.player().insert(Player {
        identity: ctx.sender,
        room_code: code.to_string(),
        slot,
        name: safe_name(name).unwrap_or_else(|| default_name(slot)),
        color: color_for(slot),
        hp: 100,
        angle: if slot == 0 { 45.0 } else { 135.0 },
        power: 60.0,
        x: if slot == 0 { 200.0 } else { 1000.0 },
        y: 0.0,
        connected: true,
        ammo_standard: 99,
        ammo_cluster: 3,
        ammo_nuke: 1,
        client_id: client_id.to_string(),
    });
    Ok(())
}

fn start_match(ctx: &ReducerContext, code: &str) -> Result<(), String> {
    let mut room = ctx
        .db
        .match_room()
        .room_code()
        .find(code.to_string())
        .ok_or("Room not found.")?;
    let terrain = generate_terrain(room.terrain_seed);

    for mut p in players_in(ctx, code) {
        p.y = get_terrain_height(&terrain, p.x);
        ctx.db.player().identity().update(p);
    }

    room.terrain = terrain;
    room.status = "playing".to_string();
    room.active_player_slot = 0;
    room.turn_started_at = Some(ctx.timestamp);
    room.disconnect_deadline = None;
    room.winner_identity = None;
    ctx.db.match_room().room_code().update(room);
    Ok(())
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

struct Weapon {
    explosion_radius: f32,
    damage: f32,
}

fn weapon(id: &str) -> Weapon {
    match id {
        "cluster" => Weapon {
            explosion_radius: 45.0,
            damage: 15.0,
        },
        "nuke" => Weapon {
            explosion_radius: 130.0,
            damage: 55.0,
        },
        _ => Weapon {
            explosion_radius: 60.0,
            damage: 25.0,
        },
    }
}

struct Sim {
    start_x: f32,
    start_y: f32,
    vx: f32,
    vy: f32,
    impact_x: f32,
    impact_y: f32,
    tti_ms: u64,
}

fn simulate_projectile(
    shooter: &Player,
    terrain: &[f32],
    players: &[Player],
    angle: f32,
    power: f32,
    wind: f32,
) -> Sim {
    let radians = clamp(angle, 0.0, 180.0) * PI / 180.0;
    let speed = clamp(power, 1.0, 100.0) * 0.35 + 2.0;
    let start_x = shooter.x + radians.cos() * 20.0;
    let start_y = shooter.y - 15.0 - radians.sin() * 20.0;
    let vx0 = radians.cos() * speed;
    let vy0 = -radians.sin() * speed;

    let (mut x, mut y) = (start_x, start_y);
    let (mut vx, mut vy) = (vx0, vy0);
    let (mut impact_x, mut impact_y) = (x, y);
    let mut tick: u64 = 0;

    while tick < MAX_TICKS {
        x += vx;
        y += vy;
        vy += GRAVITY;
        vx += wind;
        impact_x = x;
        impact_y = y;
        if has_collided(x, y, terrain, players) {
            break;
        }
        tick += 1;
    }

    Sim {
        start_x,
        start_y,
        vx: vx0,
        vy: vy0,
        impact_x: round2(impact_x),
        impact_y: round2(impact_y),
        tti_ms: ((tick + 1) * TICK_MS).max(TICK_MS),
    }
}

fn has_collided(px: f32, py: f32, terrain: &[f32], players: &[Player]) -> bool {
    if py > HEIGHT as f32 || px < 0.0 || px > WIDTH as f32 {
        return true;
    }
    let ix = px.floor() as i32;
    if ix >= 0 && (ix as usize) < terrain.len() && py >= terrain[ix as usize] {
        return true;
    }
    players
        .iter()
        .any(|p| p.hp > 0 && ((p.x - px).powi(2) + ((p.y - 8.0) - py).powi(2)).sqrt() < 15.0)
}

fn generate_terrain(seed: i64) -> Vec<f32> {
    let o1 = seeded_range(seed, 1) * 1000.0;
    let o2 = seeded_range(seed, 2) * 1000.0;
    let o3 = seeded_range(seed, 3) * 1000.0;
    let mut terrain = Vec::with_capacity(WIDTH);
    for x in 0..WIDTH {
        let xf = x as f32;
        let mut y = HEIGHT as f32 * 0.6;
        y += ((xf + o1) / 200.0).sin() * 80.0;
        y += ((xf + o2) / 70.0).sin() * 30.0;
        y += ((xf + o3) / 15.0).sin() * 5.0;
        terrain.push(round2(y));
    }
    terrain
}

fn seeded_range(seed: i64, salt: i64) -> f32 {
    let mut v = (seed.wrapping_add(salt.wrapping_mul(0x9e37_79b9)) as u64 & 0xffff_ffff) as u32;
    v = (v ^ (v >> 16)).wrapping_mul(0x85eb_ca6b);
    v = (v ^ (v >> 13)).wrapping_mul(0xc2b2_ae35);
    v ^= v >> 16;
    (v as f32) / (u32::MAX as f32)
}

fn get_terrain_height(terrain: &[f32], x: f32) -> f32 {
    let ix = x.floor() as i32;
    if ix >= 0 && (ix as usize) < terrain.len() {
        terrain[ix as usize]
    } else {
        HEIGHT as f32
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

fn clamp(v: f32, min: f32, max: f32) -> f32 {
    if !v.is_finite() {
        return min;
    }
    v.max(min).min(max)
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
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

fn normalize_weapon(id: &str) -> &'static str {
    match id {
        "cluster" => "cluster",
        "nuke" => "nuke",
        _ => "standard",
    }
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
