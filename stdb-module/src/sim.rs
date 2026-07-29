//! Pure gameplay math: terrain, weapons, ballistics, and blast resolution.
//!
//! Nothing in here touches `spacetimedb` — no tables, no scheduler, no
//! `ReducerContext`. That keeps it compilable (and unit-testable) for the host
//! target, which the WASM-only module crate is not. See `tests-core/`.
//!
//! `lib.rs` adapts `Player` table rows into the plain [`Tank`] view used here,
//! so the authoritative shot resolution and the robot's aim search run through
//! exactly the same simulator.

use core::f32::consts::PI;

pub const WIDTH: usize = 1200;
pub const HEIGHT: usize = 800;
pub const GRAVITY: f32 = 0.2;
pub const MAX_TICKS: u64 = 1800;
pub const TICK_MS: u64 = 16;

/// Vertical offset from a tank's ground position to the middle of its hull.
/// Both collision and blast damage measure against the hull, not the treads.
pub const HULL_OFFSET: f32 = 8.0;

/// Extra radius beyond the crater in which a tank still takes damage.
pub const HULL_RADIUS: f32 = 15.0;

/// A tank as the physics cares about it: where it sits and whether it's alive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tank {
    pub x: f32,
    pub y: f32,
    pub hp: i32,
}

impl Tank {
    pub fn new(x: f32, y: f32, hp: i32) -> Self {
        Self { x, y, hp }
    }

    /// Center of the hull — the point shots are scored against.
    pub fn hull_y(&self) -> f32 {
        self.y - HULL_OFFSET
    }
}

pub struct Weapon {
    pub explosion_radius: f32,
    pub damage: f32,
}

/// Canonical weapon ids. Anything else normalizes to `"standard"`.
pub const WEAPON_STANDARD: &str = "standard";
pub const WEAPON_CLUSTER: &str = "cluster";
pub const WEAPON_NUKE: &str = "nuke";

pub fn normalize_weapon(id: &str) -> &'static str {
    match id {
        WEAPON_CLUSTER => WEAPON_CLUSTER,
        WEAPON_NUKE => WEAPON_NUKE,
        _ => WEAPON_STANDARD,
    }
}

pub fn weapon(id: &str) -> Weapon {
    match id {
        WEAPON_CLUSTER => Weapon {
            explosion_radius: 45.0,
            damage: 15.0,
        },
        WEAPON_NUKE => Weapon {
            explosion_radius: 130.0,
            damage: 55.0,
        },
        _ => Weapon {
            explosion_radius: 60.0,
            damage: 25.0,
        },
    }
}

/// Result of running a shot to completion.
#[derive(Clone, Copy, Debug)]
pub struct Shot {
    pub start_x: f32,
    pub start_y: f32,
    pub vx: f32,
    pub vy: f32,
    pub impact_x: f32,
    pub impact_y: f32,
    pub tti_ms: u64,
}

/// Muzzle position for a given tank and angle.
pub fn muzzle(shooter: &Tank, angle: f32) -> (f32, f32) {
    let radians = clamp(angle, 0.0, 180.0) * PI / 180.0;
    (
        shooter.x + radians.cos() * 20.0,
        shooter.y - 15.0 - radians.sin() * 20.0,
    )
}

/// Fly a shot until it hits something (or times out) and report where.
///
/// Deterministic: the same inputs always produce the same impact, which is what
/// lets the robot search candidate aims with the very same code that later
/// resolves its shot for real.
pub fn simulate_projectile(
    shooter: &Tank,
    terrain: &[f32],
    tanks: &[Tank],
    angle: f32,
    power: f32,
    wind: f32,
) -> Shot {
    let radians = clamp(angle, 0.0, 180.0) * PI / 180.0;
    let speed = clamp(power, 1.0, 100.0) * 0.35 + 2.0;
    let (start_x, start_y) = muzzle(shooter, angle);
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
        if has_collided(x, y, terrain, tanks) {
            break;
        }
        tick += 1;
    }

    Shot {
        start_x,
        start_y,
        vx: vx0,
        vy: vy0,
        impact_x: round2(impact_x),
        impact_y: round2(impact_y),
        tti_ms: ((tick + 1) * TICK_MS).max(TICK_MS),
    }
}

pub fn has_collided(px: f32, py: f32, terrain: &[f32], tanks: &[Tank]) -> bool {
    if py > HEIGHT as f32 || px < 0.0 || px > WIDTH as f32 {
        return true;
    }
    let ix = px.floor() as i32;
    if ix >= 0 && (ix as usize) < terrain.len() && py >= terrain[ix as usize] {
        return true;
    }
    tanks
        .iter()
        .any(|t| t.hp > 0 && distance(t.x, t.hull_y(), px, py) < HULL_RADIUS)
}

/// Raise the heightmap inside the blast circle (higher y == deeper crater,
/// since the canvas y-axis points down).
pub fn carve_terrain(terrain: &mut [f32], cx: f32, cy: f32, radius: f32) {
    if terrain.is_empty() {
        return;
    }
    let from_x = (cx - radius).floor().max(0.0) as usize;
    let to_x = (cx + radius).floor().min((WIDTH - 1) as f32).max(0.0) as usize;
    for (x, cell) in terrain.iter_mut().enumerate().take(to_x + 1).skip(from_x) {
        let dx = x as f32 - cx;
        let dy = (radius * radius - dx * dx).max(0.0).sqrt();
        if *cell < cy + dy {
            *cell = round2((cy + dy).min(HEIGHT as f32));
        }
    }
}

/// Damage a blast at `(cx, cy)` deals to `tank`, with linear falloff.
pub fn blast_damage(w: &Weapon, tank: &Tank, cx: f32, cy: f32) -> i32 {
    let reach = w.explosion_radius + HULL_RADIUS;
    let dist = distance(tank.x, tank.hull_y(), cx, cy);
    if dist >= reach {
        return 0;
    }
    let falloff = (1.0 - dist / reach).max(0.1);
    (w.damage * falloff).floor() as i32
}

/// True when a blast at `(cx, cy)` would reach `tank` at all.
pub fn in_blast_radius(w: &Weapon, tank: &Tank, cx: f32, cy: f32) -> bool {
    distance(tank.x, tank.hull_y(), cx, cy) < w.explosion_radius + HULL_RADIUS
}

pub fn generate_terrain(seed: i64) -> Vec<f32> {
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

pub fn seeded_range(seed: i64, salt: i64) -> f32 {
    let mut v = (seed.wrapping_add(salt.wrapping_mul(0x9e37_79b9)) as u64 & 0xffff_ffff) as u32;
    v = (v ^ (v >> 16)).wrapping_mul(0x85eb_ca6b);
    v = (v ^ (v >> 13)).wrapping_mul(0xc2b2_ae35);
    v ^= v >> 16;
    (v as f32) / (u32::MAX as f32)
}

pub fn get_terrain_height(terrain: &[f32], x: f32) -> f32 {
    let ix = x.floor() as i32;
    if ix >= 0 && (ix as usize) < terrain.len() {
        terrain[ix as usize]
    } else {
        HEIGHT as f32
    }
}

pub fn distance(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt()
}

pub fn clamp(v: f32, min: f32, max: f32) -> f32 {
    if !v.is_finite() {
        return min;
    }
    v.max(min).min(max)
}

pub fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_terrain(height: f32) -> Vec<f32> {
        vec![height; WIDTH]
    }

    #[test]
    fn terrain_generation_is_deterministic_and_bounded() {
        let a = generate_terrain(4242);
        let b = generate_terrain(4242);
        let c = generate_terrain(99);
        assert_eq!(a, b, "same seed must yield identical terrain");
        assert_ne!(a, c, "different seeds must differ");
        assert_eq!(a.len(), WIDTH);
        for y in &a {
            assert!(*y > 0.0 && *y < HEIGHT as f32, "terrain out of bounds: {y}");
        }
    }

    #[test]
    fn weapons_normalize_unknown_ids_to_standard() {
        assert_eq!(normalize_weapon("nuke"), WEAPON_NUKE);
        assert_eq!(normalize_weapon("cluster"), WEAPON_CLUSTER);
        assert_eq!(normalize_weapon("laser"), WEAPON_STANDARD);
        assert_eq!(normalize_weapon(""), WEAPON_STANDARD);
    }

    #[test]
    fn shots_arc_downrange_and_terminate() {
        let terrain = flat_terrain(500.0);
        let shooter = Tank::new(200.0, 500.0, 100);
        let shot = simulate_projectile(&shooter, &terrain, &[shooter], 45.0, 60.0, 0.0);
        assert!(shot.impact_x > shooter.x, "45deg shot must travel right");
        assert!(shot.tti_ms >= TICK_MS);
        assert!(shot.tti_ms < MAX_TICKS * TICK_MS, "shot never landed");
    }

    #[test]
    fn obtuse_angles_fire_left() {
        let terrain = flat_terrain(500.0);
        let shooter = Tank::new(1000.0, 500.0, 100);
        let shot = simulate_projectile(&shooter, &terrain, &[shooter], 135.0, 60.0, 0.0);
        assert!(shot.impact_x < shooter.x, "135deg shot must travel left");
    }

    #[test]
    fn simulation_is_deterministic() {
        let terrain = flat_terrain(500.0);
        let shooter = Tank::new(200.0, 500.0, 100);
        let a = simulate_projectile(&shooter, &terrain, &[shooter], 51.0, 73.0, 0.02);
        let b = simulate_projectile(&shooter, &terrain, &[shooter], 51.0, 73.0, 0.02);
        assert_eq!((a.impact_x, a.impact_y, a.tti_ms), (b.impact_x, b.impact_y, b.tti_ms));
    }

    #[test]
    fn shot_stops_on_a_tank() {
        let terrain = flat_terrain(500.0);
        let shooter = Tank::new(200.0, 500.0, 100);
        // Park a tank exactly where the unobstructed shell would have landed.
        // Kept slow on purpose: at high power the per-tick step exceeds the
        // hull radius and shells tunnel straight through, which is a known
        // property of this fixed-step simulator.
        let clear = simulate_projectile(&shooter, &terrain, &[shooter], 45.0, 20.0, 0.0);
        let target = Tank::new(clear.impact_x, 500.0, 100);
        let blocked = simulate_projectile(&shooter, &terrain, &[shooter, target], 45.0, 20.0, 0.0);
        assert!(
            blocked.tti_ms < clear.tti_ms,
            "hull should stop the shell before it reaches the ground"
        );
        assert!(blocked.impact_x < clear.impact_x);
    }

    #[test]
    fn dead_tanks_do_not_block_shots() {
        let terrain = flat_terrain(500.0);
        let shooter = Tank::new(200.0, 500.0, 100);
        let corpse = Tank::new(400.0, 500.0, 0);
        assert!(!has_collided(400.0, 492.0, &terrain, &[corpse]));
        assert!(has_collided(
            400.0,
            492.0,
            &terrain,
            &[Tank::new(400.0, 500.0, 1)]
        ));
        let _ = shooter;
    }

    #[test]
    fn craters_only_deepen_terrain() {
        let mut terrain = flat_terrain(500.0);
        carve_terrain(&mut terrain, 600.0, 480.0, 60.0);
        assert!(terrain[600] > 500.0, "blast should carve at the center");
        assert_eq!(terrain[0], 500.0, "blast must not touch distant terrain");

        let before = terrain.clone();
        // A shallower blast in the same spot leaves the deeper crater intact.
        carve_terrain(&mut terrain, 600.0, 400.0, 10.0);
        assert_eq!(terrain[600], before[600]);
    }

    #[test]
    fn crater_stays_inside_the_map() {
        let mut terrain = flat_terrain(500.0);
        carve_terrain(&mut terrain, 5.0, 790.0, 130.0);
        carve_terrain(&mut terrain, (WIDTH - 2) as f32, 790.0, 130.0);
        for y in &terrain {
            assert!(*y <= HEIGHT as f32);
        }
    }

    #[test]
    fn blast_damage_falls_off_with_distance() {
        let w = weapon(WEAPON_STANDARD);
        let direct = blast_damage(&w, &Tank::new(600.0, 500.0, 100), 600.0, 492.0);
        let near = blast_damage(&w, &Tank::new(600.0, 500.0, 100), 640.0, 492.0);
        let far = blast_damage(&w, &Tank::new(600.0, 500.0, 100), 900.0, 492.0);
        assert!(direct > near, "closer hits must hurt more ({direct} vs {near})");
        assert!(near > 0);
        assert_eq!(far, 0, "out-of-range blasts deal nothing");
        assert!(direct <= w.damage as i32);
    }

    #[test]
    fn nuke_out_damages_standard() {
        let tank = Tank::new(600.0, 500.0, 100);
        let standard = blast_damage(&weapon(WEAPON_STANDARD), &tank, 600.0, 492.0);
        let nuke = blast_damage(&weapon(WEAPON_NUKE), &tank, 600.0, 492.0);
        assert!(nuke > standard);
    }

    #[test]
    fn terrain_height_falls_back_outside_the_map() {
        let terrain = flat_terrain(500.0);
        assert_eq!(get_terrain_height(&terrain, 10.0), 500.0);
        assert_eq!(get_terrain_height(&terrain, -5.0), HEIGHT as f32);
        assert_eq!(get_terrain_height(&terrain, 5000.0), HEIGHT as f32);
    }

    #[test]
    fn clamp_rejects_non_finite_input() {
        assert_eq!(clamp(f32::NAN, 1.0, 100.0), 1.0);
        assert_eq!(clamp(f32::INFINITY, 1.0, 100.0), 1.0);
        assert_eq!(clamp(150.0, 1.0, 100.0), 100.0);
    }
}
