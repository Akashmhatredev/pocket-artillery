//! The robot opponent's brain.
//!
//! Pure decision making: given a snapshot of the battlefield it returns the aim
//! and weapon it wants to use. It has no privileged information and no special
//! powers — it searches candidate aims with [`sim::simulate_projectile`], the
//! same simulator that later resolves the shot for real, and its choice is then
//! pushed through the identical `launch_shot` path a human's fire goes through.
//!
//! Everything here is deterministic given `seed`, which makes the robot's
//! behaviour reproducible and unit-testable (see the tests at the bottom).

use crate::sim::{self, Tank};

/// Score penalty for an aim whose blast would also catch the robot. Large
/// enough that any non-suicidal shot wins, small enough to stay comparable.
const SELF_HIT_PENALTY: f32 = 5_000.0;

/// Aims are searched in this power band; below ~20 the shell barely clears the
/// muzzle, which is never the shot the robot wants.
const POWER_MIN: f32 = 20.0;
const POWER_MAX: f32 = 100.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Difficulty {
    Easy,
    Normal,
    Hard,
}

impl Difficulty {
    pub fn from_label(label: &str) -> Difficulty {
        match label.trim().to_ascii_lowercase().as_str() {
            "easy" => Difficulty::Easy,
            "hard" => Difficulty::Hard,
            _ => Difficulty::Normal,
        }
    }

    pub fn as_label(&self) -> &'static str {
        match self {
            Difficulty::Easy => "easy",
            Difficulty::Normal => "normal",
            Difficulty::Hard => "hard",
        }
    }

    /// How badly the robot fumbles a solution it has already found:
    /// `(degrees, power units)` of uniform error.
    fn aim_error(&self) -> (f32, f32) {
        match self {
            Difficulty::Easy => (8.0, 14.0),
            Difficulty::Normal => (3.0, 5.0),
            Difficulty::Hard => (0.8, 1.2),
        }
    }

    /// Refinement steps applied around the coarse grid winner. Easy never
    /// refines, so it only ever finds a roughly-correct solution.
    fn refine_steps(&self) -> &'static [f32] {
        match self {
            Difficulty::Easy => &[],
            Difficulty::Normal => &[1.0],
            Difficulty::Hard => &[1.0, 0.25],
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Difficulty::Easy => "Scrap-Bot",
            Difficulty::Normal => "Iron Sentinel",
            Difficulty::Hard => "Overlord",
        }
    }
}

/// Shells the robot has left, mirroring the `Player` row's ammo columns.
#[derive(Clone, Copy, Debug)]
pub struct Ammo {
    pub standard: u32,
    pub cluster: u32,
    pub nuke: u32,
}

impl Ammo {
    pub fn count(&self, weapon_id: &str) -> u32 {
        match sim::normalize_weapon(weapon_id) {
            sim::WEAPON_CLUSTER => self.cluster,
            sim::WEAPON_NUKE => self.nuke,
            _ => self.standard,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.standard == 0 && self.cluster == 0 && self.nuke == 0
    }
}

/// What the robot decided to do this turn.
#[derive(Clone, Copy, Debug)]
pub struct ShotPlan {
    pub angle: f32,
    pub power: f32,
    pub weapon_id: &'static str,
    /// Where the plan expects the shell to land.
    pub predicted_x: f32,
    pub predicted_y: f32,
    /// Distance from that prediction to the target's hull, in pixels.
    pub miss_distance: f32,
    /// True when the shell is expected to land close enough to hurt the target.
    pub expects_hit: bool,
}

/// Everything the brain is allowed to look at.
pub struct Battlefield<'a> {
    pub shooter: Tank,
    pub target: Tank,
    pub ammo: Ammo,
    pub terrain: &'a [f32],
    /// All tanks (including the shooter) so shots can be blocked correctly.
    pub tanks: &'a [Tank],
    pub wind: f32,
}

/// Pick a weapon and an aim for this turn, or `None` when the robot cannot act
/// (no ammo, no living target, no terrain yet).
pub fn plan_shot(field: &Battlefield, difficulty: Difficulty, seed: u64) -> Option<ShotPlan> {
    if field.shooter.hp <= 0 || field.target.hp <= 0 || field.terrain.is_empty() {
        return None;
    }

    let mut chosen: Option<(f32, &'static str, f32, f32)> = None; // (score, weapon, angle, power)
    for weapon_id in weapon_preference(&field.ammo, field.target.hp, difficulty) {
        let (angle, power, score) = search_aim(field, weapon_id, difficulty);
        let better = chosen.map(|(best, _, _, _)| score < best).unwrap_or(true);
        if better {
            chosen = Some((score, weapon_id, angle, power));
        }
        // A shot that does not blow the robot up is good enough; only keep
        // shopping for a smaller shell when the best aim is self-destructive.
        if score < SELF_HIT_PENALTY {
            break;
        }
    }

    let (ideal_score, weapon_id, ideal_angle, ideal_power) = chosen?;
    let w = sim::weapon(weapon_id);
    let (angle_error, power_error) = difficulty.aim_error();
    let (lo, hi) = angle_window(&field.shooter, &field.target);

    let mut angle = sim::clamp(ideal_angle + jitter(seed, 1, angle_error), lo, hi);
    let mut power = sim::clamp(ideal_power + jitter(seed, 2, power_error), 1.0, POWER_MAX);

    let mut shot = sim::simulate_projectile(
        &field.shooter,
        field.terrain,
        field.tanks,
        angle,
        power,
        field.wind,
    );

    // A sloppy robot is fine; one that fumbles a shell onto its own hull is
    // just broken. If the jitter turned a clean solution into a self-hit, fire
    // the clean solution instead. (When even the ideal aim was unavoidably
    // self-destructive we still take the shot — the turn has to advance.)
    let ideal_was_safe = ideal_score < SELF_HIT_PENALTY;
    if ideal_was_safe && sim::in_blast_radius(&w, &field.shooter, shot.impact_x, shot.impact_y) {
        angle = ideal_angle;
        power = ideal_power;
        shot = sim::simulate_projectile(
            &field.shooter,
            field.terrain,
            field.tanks,
            angle,
            power,
            field.wind,
        );
    }

    let miss_distance = sim::distance(
        shot.impact_x,
        shot.impact_y,
        field.target.x,
        field.target.hull_y(),
    );

    Some(ShotPlan {
        angle: sim::round2(angle),
        power: sim::round2(power),
        weapon_id,
        predicted_x: shot.impact_x,
        predicted_y: shot.impact_y,
        miss_distance: sim::round2(miss_distance),
        expects_hit: sim::in_blast_radius(&w, &field.target, shot.impact_x, shot.impact_y),
    })
}

/// Weapons to consider, best first. Empty when the robot is out of shells.
///
/// The rule is deliberately simple and stateless: hoard the heavy ordnance
/// until it can actually close out the match, otherwise lob standard shells.
pub fn weapon_preference(
    ammo: &Ammo,
    target_hp: i32,
    difficulty: Difficulty,
) -> Vec<&'static str> {
    let fallback = [sim::WEAPON_STANDARD, sim::WEAPON_CLUSTER, sim::WEAPON_NUKE];
    let available: Vec<&'static str> = fallback
        .iter()
        .copied()
        .filter(|id| ammo.count(id) > 0)
        .collect();

    if available.is_empty() {
        return available;
    }
    // The rookie bot never plays its specials while it still has shells.
    if difficulty == Difficulty::Easy {
        return available;
    }
    // A nuke one-shots a weakened tank; spending it earlier is a waste.
    let nuke_finishes = ammo.nuke > 0 && target_hp <= sim::weapon(sim::WEAPON_NUKE).damage as i32;
    if nuke_finishes {
        let mut order = vec![sim::WEAPON_NUKE];
        order.extend(available.iter().copied().filter(|id| *id != sim::WEAPON_NUKE));
        return order;
    }
    available
}

/// Grid-search the aim that lands closest to the target's hull.
///
/// Returns `(angle, power, score)`; lower score is better. The coarse sweep is
/// cheap (~300 simulated shots) and the refinement passes tighten it without
/// re-scanning the whole space.
fn search_aim(field: &Battlefield, weapon_id: &str, difficulty: Difficulty) -> (f32, f32, f32) {
    let w = sim::weapon(weapon_id);
    let (lo, hi) = angle_window(&field.shooter, &field.target);

    let mut best_angle = (lo + hi) / 2.0;
    let mut best_power = 60.0;
    let mut best_score = f32::MAX;

    let mut angle = lo;
    while angle <= hi {
        let mut power = POWER_MIN;
        while power <= POWER_MAX {
            let score = score_aim(field, &w, angle, power);
            if score < best_score {
                best_score = score;
                best_angle = angle;
                best_power = power;
            }
            power += 5.0;
        }
        angle += 5.0;
    }

    for step in difficulty.refine_steps() {
        let span = step * 4.0;
        let (center_angle, center_power) = (best_angle, best_power);
        let mut angle = (center_angle - span).max(lo);
        let angle_end = (center_angle + span).min(hi);
        while angle <= angle_end {
            let mut power = (center_power - span).max(1.0);
            let power_end = (center_power + span).min(POWER_MAX);
            while power <= power_end {
                let score = score_aim(field, &w, angle, power);
                if score < best_score {
                    best_score = score;
                    best_angle = angle;
                    best_power = power;
                }
                power += *step;
            }
            angle += *step;
        }
    }

    (best_angle, best_power, best_score)
}

fn score_aim(field: &Battlefield, w: &sim::Weapon, angle: f32, power: f32) -> f32 {
    let shot = sim::simulate_projectile(
        &field.shooter,
        field.terrain,
        field.tanks,
        angle,
        power,
        field.wind,
    );
    let mut score = sim::distance(
        shot.impact_x,
        shot.impact_y,
        field.target.x,
        field.target.hull_y(),
    );
    // Landing a hit is worthless if the robot goes up with it.
    if sim::in_blast_radius(w, &field.shooter, shot.impact_x, shot.impact_y) {
        score += SELF_HIT_PENALTY;
    }
    // Tie-breaker: among equally accurate solutions take the gentler lob.
    score + power * 0.02
}

/// Angles that actually point at the target. `cos(angle)` sets the horizontal
/// direction, so a leftward target needs an obtuse angle and vice versa.
fn angle_window(shooter: &Tank, target: &Tank) -> (f32, f32) {
    if target.x < shooter.x {
        (95.0, 179.0)
    } else {
        (1.0, 85.0)
    }
}

/// Uniform error in `[-magnitude, magnitude]`, derived from `seed` so a given
/// turn always produces the same "mistake".
fn jitter(seed: u64, salt: u64, magnitude: f32) -> f32 {
    (rand_unit(seed, salt) * 2.0 - 1.0) * magnitude
}

/// splitmix64 → `[0, 1)`.
fn rand_unit(seed: u64, salt: u64) -> f32 {
    let mut z = seed.wrapping_add(salt.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    ((z >> 40) as f32) / ((1u64 << 24) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_AMMO: Ammo = Ammo {
        standard: 99,
        cluster: 3,
        nuke: 1,
    };

    fn rolling_terrain() -> Vec<f32> {
        sim::generate_terrain(20_260_727)
    }

    /// A standard duel: robot in slot 1 on the right, human in slot 0.
    fn duel<'a>(terrain: &'a [f32], tanks: &'a [Tank], ammo: Ammo) -> Battlefield<'a> {
        Battlefield {
            shooter: tanks[1],
            target: tanks[0],
            ammo,
            terrain,
            tanks,
            wind: 0.0,
        }
    }

    fn seated(terrain: &[f32], x: f32, hp: i32) -> Tank {
        Tank::new(x, sim::get_terrain_height(terrain, x), hp)
    }

    #[test]
    fn difficulty_parses_labels_and_defaults_to_normal() {
        assert_eq!(Difficulty::from_label("easy"), Difficulty::Easy);
        assert_eq!(Difficulty::from_label("HARD"), Difficulty::Hard);
        assert_eq!(Difficulty::from_label(" Normal "), Difficulty::Normal);
        assert_eq!(Difficulty::from_label("impossible"), Difficulty::Normal);
        assert_eq!(Difficulty::from_label(""), Difficulty::Normal);
        assert_eq!(Difficulty::from_label("easy").as_label(), "easy");
    }

    #[test]
    fn hard_robot_lands_close_to_the_target() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        let plan = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Hard, 7)
            .expect("robot should find a shot");
        assert!(
            plan.miss_distance < 60.0,
            "hard robot missed by {}px (angle {}, power {})",
            plan.miss_distance,
            plan.angle,
            plan.power
        );
        assert!(plan.expects_hit, "hard robot should expect to connect");
    }

    #[test]
    fn easy_robot_is_measurably_worse_than_hard() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        // Averaged over seeds: a single seed can flatter either difficulty.
        let mean = |difficulty| {
            let total: f32 = (0..24)
                .map(|seed| {
                    plan_shot(&duel(&terrain, &tanks, FULL_AMMO), difficulty, seed)
                        .expect("plan")
                        .miss_distance
                })
                .sum();
            total / 24.0
        };
        let easy = mean(Difficulty::Easy);
        let hard = mean(Difficulty::Hard);
        assert!(
            hard < easy,
            "hard ({hard}px) should outshoot easy ({easy}px)"
        );
    }

    #[test]
    fn aim_always_points_at_the_target() {
        let terrain = rolling_terrain();
        // Robot on the right must fire left (obtuse angles).
        let right = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        for seed in 0..12 {
            for difficulty in [Difficulty::Easy, Difficulty::Normal, Difficulty::Hard] {
                let plan = plan_shot(&duel(&terrain, &right, FULL_AMMO), difficulty, seed).unwrap();
                assert!(
                    plan.angle > 90.0 && plan.angle <= 180.0,
                    "expected a leftward shot, got {}",
                    plan.angle
                );
                assert!(plan.power >= 1.0 && plan.power <= 100.0);
            }
        }
        // ...and mirrored when the robot sits on the left.
        let flipped = [seated(&terrain, 1000.0, 100), seated(&terrain, 200.0, 100)];
        let plan = plan_shot(&duel(&terrain, &flipped, FULL_AMMO), Difficulty::Hard, 3).unwrap();
        assert!(plan.angle < 90.0, "expected a rightward shot, got {}", plan.angle);
    }

    #[test]
    fn planning_is_deterministic_for_a_seed() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        let a = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Normal, 11).unwrap();
        let b = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Normal, 11).unwrap();
        assert_eq!((a.angle, a.power, a.weapon_id), (b.angle, b.power, b.weapon_id));

        let c = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Normal, 12).unwrap();
        assert!(
            (a.angle - c.angle).abs() > f32::EPSILON || (a.power - c.power).abs() > f32::EPSILON,
            "different turns should not produce an identical mistake"
        );
    }

    #[test]
    fn never_fires_a_shell_it_does_not_have() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];

        let only_cluster = Ammo {
            standard: 0,
            cluster: 2,
            nuke: 0,
        };
        let plan = plan_shot(&duel(&terrain, &tanks, only_cluster), Difficulty::Normal, 1).unwrap();
        assert_eq!(plan.weapon_id, sim::WEAPON_CLUSTER);

        let only_nuke = Ammo {
            standard: 0,
            cluster: 0,
            nuke: 1,
        };
        let plan = plan_shot(&duel(&terrain, &tanks, only_nuke), Difficulty::Normal, 1).unwrap();
        assert_eq!(plan.weapon_id, sim::WEAPON_NUKE);
    }

    #[test]
    fn no_ammo_means_no_plan() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        let empty = Ammo {
            standard: 0,
            cluster: 0,
            nuke: 0,
        };
        assert!(empty.is_empty());
        assert!(plan_shot(&duel(&terrain, &tanks, empty), Difficulty::Hard, 1).is_none());
    }

    #[test]
    fn no_plan_without_a_living_target_or_terrain() {
        let terrain = rolling_terrain();
        let dead = [seated(&terrain, 200.0, 0), seated(&terrain, 1000.0, 100)];
        assert!(plan_shot(&duel(&terrain, &dead, FULL_AMMO), Difficulty::Hard, 1).is_none());

        let wrecked = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 0)];
        assert!(plan_shot(&duel(&terrain, &wrecked, FULL_AMMO), Difficulty::Hard, 1).is_none());

        let alive = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        let mut field = duel(&terrain, &alive, FULL_AMMO);
        field.terrain = &[];
        assert!(plan_shot(&field, Difficulty::Hard, 1).is_none());
    }

    #[test]
    fn saves_the_nuke_until_it_can_finish_the_job() {
        let healthy = weapon_preference(&FULL_AMMO, 100, Difficulty::Normal);
        assert_eq!(healthy.first().copied(), Some(sim::WEAPON_STANDARD));

        let finishable = weapon_preference(&FULL_AMMO, 40, Difficulty::Normal);
        assert_eq!(finishable.first().copied(), Some(sim::WEAPON_NUKE));

        // The rookie bot keeps lobbing shells regardless.
        let easy = weapon_preference(&FULL_AMMO, 40, Difficulty::Easy);
        assert_eq!(easy.first().copied(), Some(sim::WEAPON_STANDARD));
    }

    #[test]
    fn weapon_preference_is_empty_without_ammo() {
        let empty = Ammo {
            standard: 0,
            cluster: 0,
            nuke: 0,
        };
        assert!(weapon_preference(&empty, 100, Difficulty::Hard).is_empty());
        assert!(weapon_preference(&empty, 10, Difficulty::Hard).is_empty());
    }

    #[test]
    fn never_drops_a_shell_on_its_own_head() {
        let terrain = rolling_terrain();
        for gap in [200.0, 350.0, 500.0, 650.0, 800.0f32] {
            let tanks = [
                seated(&terrain, 1000.0 - gap, 100),
                seated(&terrain, 1000.0, 100),
            ];
            let field = duel(&terrain, &tanks, FULL_AMMO);
            for difficulty in [Difficulty::Easy, Difficulty::Normal, Difficulty::Hard] {
                for seed in 0..8u64 {
                    let plan = plan_shot(&field, difficulty, seed).unwrap();
                    let w = sim::weapon(plan.weapon_id);
                    assert!(
                        !sim::in_blast_radius(&w, &field.shooter, plan.predicted_x, plan.predicted_y),
                        "gap {gap} / {difficulty:?} / seed {seed}: planned {} impact at ({}, {}) \
                         would damage the robot itself",
                        plan.weapon_id,
                        plan.predicted_x,
                        plan.predicted_y
                    );
                }
            }
        }
    }

    #[test]
    fn still_takes_a_shot_when_every_option_would_splash_itself() {
        let terrain = vec![500.0f32; sim::WIDTH];
        // Point blank: no shell in the inventory has a blast small enough to
        // spare the robot. It must still shoot rather than stall the turn.
        let tanks = [Tank::new(560.0, 500.0, 100), Tank::new(600.0, 500.0, 100)];
        let plan = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Hard, 5);
        assert!(plan.is_some(), "robot must always produce a move when it has ammo");
    }

    #[test]
    fn compensates_for_wind() {
        let terrain = rolling_terrain();
        let tanks = [seated(&terrain, 200.0, 100), seated(&terrain, 1000.0, 100)];
        let calm = plan_shot(&duel(&terrain, &tanks, FULL_AMMO), Difficulty::Hard, 4).unwrap();

        let mut windy_field = duel(&terrain, &tanks, FULL_AMMO);
        windy_field.wind = 0.06;
        let windy = plan_shot(&windy_field, Difficulty::Hard, 4).unwrap();

        assert!(
            windy.miss_distance < 80.0,
            "robot should still connect in wind, missed by {}px",
            windy.miss_distance
        );
        assert!(
            (calm.angle - windy.angle).abs() > f32::EPSILON
                || (calm.power - windy.power).abs() > f32::EPSILON,
            "wind should change the solution"
        );
    }

    #[test]
    fn jitter_stays_inside_its_magnitude() {
        for seed in 0..500u64 {
            let j = jitter(seed, 1, 3.0);
            assert!(j >= -3.0 && j <= 3.0, "jitter {j} escaped its bound");
            let u = rand_unit(seed, 9);
            assert!((0.0..1.0).contains(&u), "rand_unit {u} out of range");
        }
    }
}
