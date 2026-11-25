import { describe, expect, it } from 'vitest';
import {
  angularDistanceDeg,
  computeActualFrustumCoveragePercent,
  eulerToDirection,
  evaluateAlignment,
  generateSphereLattice,
  normalizeYawDeg,
  shortestAngleDeltaDeg,
} from '../src/core/sphereLattice';

describe('sphereLattice', () => {
  it('generates 40 targets in standard30 mode including crown rings to eliminate polar blind spots', () => {
    const targets = generateSphereLattice('sphere360', 'standard30');
    expect(targets).toHaveLength(40);
    expect(targets.filter((t) => t.ring === 'equator')).toHaveLength(12);
    expect(targets.filter((t) => t.ring === 'upper')).toHaveLength(13); // 9 mid + 4 crown
    expect(targets.filter((t) => t.ring === 'lower')).toHaveLength(13); // 9 mid + 4 crown
    expect(targets.filter((t) => t.ring === 'zenith')).toHaveLength(1);
    expect(targets.filter((t) => t.ring === 'nadir')).toHaveLength(1);
  });

  it('achieves 100% actual rectangular frustum coverage at 60x46 FOV with zero blind spots', () => {
    const targets = generateSphereLattice('sphere360', 'standard30');
    const simulatedFrames = targets.map((t) => ({
      orientation: {
        yawDeg: t.yawDeg,
        pitchDeg: t.pitchDeg,
        rollDeg: 0,
        timestampMs: 1000,
      },
      fovHorizontalDeg: 60,
      fovVerticalDeg: 46,
    }));

    // Real 1000-point Fibonacci sphere frustum projection (no shortcut)
    expect(computeActualFrustumCoveragePercent(simulatedFrames, 1000)).toBe(100);

    // Partial capture (only equator) must NOT report 100%
    const equatorOnly = simulatedFrames.slice(0, 12);
    const eqCov = computeActualFrustumCoveragePercent(equatorOnly, 1000);
    expect(eqCov).toBeGreaterThan(30);
    expect(eqCov).toBeLessThan(55);
  });

  it('computes accurate geodesic angular distance on unit sphere', () => {
    const forward = eulerToDirection(0, 0);
    const right = eulerToDirection(90, 0);
    const zenith = eulerToDirection(0, 90);
    expect(angularDistanceDeg(forward, right)).toBeCloseTo(90, 4);
    expect(angularDistanceDeg(forward, zenith)).toBeCloseTo(90, 4);
    expect(angularDistanceDeg(forward, forward)).toBeCloseTo(0, 4);
  });

  it('handles yaw wrap-around cleanly', () => {
    expect(normalizeYawDeg(-30)).toBe(330);
    expect(normalizeYawDeg(390)).toBe(30);
    expect(shortestAngleDeltaDeg(350, 10)).toBe(20);
    expect(shortestAngleDeltaDeg(10, 350)).toBe(-20);
  });

  it('rejects rapid roll around optical axis and stale timestamps in stability gate', () => {
    const targets = generateSphereLattice('sphere360', 'standard30');
    const prev = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, timestampMs: 1000 };

    // Steady sample
    const currSteady = { yawDeg: 1, pitchDeg: 0.5, rollDeg: 0.5, timestampMs: 1200 };
    const statusSteady = evaluateAlignment(currSteady, prev, targets, 320);
    expect(statusSteady.isAligned).toBe(true);
    expect(statusSteady.isSteady).toBe(true);
    expect(statusSteady.holdProgress).toBe(1);

    // Pure roll around optical axis (yaw/pitch unchanged, roll jumps 15° in 100ms = 150°/s)
    const currRolling = { yawDeg: 0, pitchDeg: 0, rollDeg: 15, timestampMs: 1100 };
    const statusRolling = evaluateAlignment(currRolling, prev, targets, 320);
    expect(statusRolling.isAligned).toBe(true);
    expect(statusRolling.isSteady).toBe(false);
    expect(statusRolling.holdProgress).toBe(0);

    // Duplicate timestamp must not pass steadiness
    const currStale = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, timestampMs: 1000 };
    const statusStale = evaluateAlignment(currStale, prev, targets, 320);
    expect(statusStale.isSteady).toBe(false);
  });
});
