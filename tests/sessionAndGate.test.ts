import { describe, expect, it } from 'vitest';
import {
  createCameraPose,
  eulerFromQuat,
  mulMat3Vec3,
  quatFromEuler,
} from '../src/core/cameraPose';
import {
  advanceHoldGate,
  computeActualFrustumCoveragePercent,
  DEFAULT_ALIGNMENT_GATE,
  generateSphereLattice,
  type HoldGateState,
} from '../src/core/sphereLattice';

describe('polar orientation & coverage floor & hold gate', () => {
  it('preserves full 3D rotation (optical axis + up vector) near poles including (0°, 88°, 180°)', () => {
    for (const c of [
      { yawDeg: 0, pitchDeg: 88, rollDeg: 180 },
      { yawDeg: 135, pitchDeg: 89.95, rollDeg: 0 },
      { yawDeg: 240, pitchDeg: -88, rollDeg: -135 },
    ]) {
      const q = quatFromEuler(c.yawDeg, c.pitchDeg, c.rollDeg);
      const extracted = eulerFromQuat(q);
      const origPose = createCameraPose({ ...c, timestampMs: 0 });
      const rtPose = createCameraPose({ ...extracted, timestampMs: 0 });

      const origOpt = mulMat3Vec3(origPose.camToWorld, { x: 0, y: 0, z: -1 });
      const rtOpt = mulMat3Vec3(rtPose.camToWorld, { x: 0, y: 0, z: -1 });
      expect(rtOpt.x).toBeCloseTo(origOpt.x, 4);
      expect(rtOpt.y).toBeCloseTo(origOpt.y, 4);
      expect(rtOpt.z).toBeCloseTo(origOpt.z, 4);

      const origUp = mulMat3Vec3(origPose.camToWorld, { x: 0, y: 1, z: 0 });
      const rtUp = mulMat3Vec3(rtPose.camToWorld, { x: 0, y: 1, z: 0 });
      expect(rtUp.x).toBeCloseTo(origUp.x, 4);
      expect(rtUp.y).toBeCloseTo(origUp.y, 4);
      expect(rtUp.z).toBeCloseTo(origUp.z, 4);
    }
  });

  it('floors coverage percentage so missing even a few samples never rounds up to 100%', () => {
    const targets = generateSphereLattice('sphere360', 'standard30');
    const withoutZenith = targets
      .filter((t) => t.id !== 'zenith-0')
      .map((t) => ({
        orientation: { yawDeg: t.yawDeg, pitchDeg: t.pitchDeg, rollDeg: 0, timestampMs: 1000 },
        fovHorizontalDeg: 60,
        fovVerticalDeg: 46,
      }));

    const cov = computeActualFrustumCoveragePercent(withoutZenith, 1000);
    expect(cov).toBeLessThan(100);
    expect(cov).toBeGreaterThanOrEqual(95);
  });

  it('resets hold timer on sensor stall gap (> 250ms) and triggers only on continuous steady samples', () => {
    const targets = generateSphereLattice('sphere360', 'standard30');
    let state: HoldGateState = { targetId: null, startMs: null };

    const s0 = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, timestampMs: 1000 };
    const s1 = { yawDeg: 0.1, pitchDeg: 0, rollDeg: 0, timestampMs: 1100 };
    const s2 = { yawDeg: 0.1, pitchDeg: 0, rollDeg: 0, timestampMs: 1250 };

    // Start hold at s1
    let res = advanceHoldGate(state, s1, s0, targets, DEFAULT_ALIGNMENT_GATE);
    state = res.nextState;
    expect(res.shouldTrigger).toBe(false);
    expect(state.startMs).toBe(1100);

    // Continuous sample at 1250ms (150ms elapsed < 320ms)
    res = advanceHoldGate(state, s2, s1, targets, DEFAULT_ALIGNMENT_GATE);
    state = res.nextState;
    expect(res.shouldTrigger).toBe(false);
    expect(res.alignment.holdProgress).toBeCloseTo(150 / DEFAULT_ALIGNMENT_GATE.holdDurationMs, 3);

    // Sensor stall gap of 400ms (> 250ms) MUST reset hold instead of firing immediately!
    const sStalled = { yawDeg: 0.1, pitchDeg: 0, rollDeg: 0, timestampMs: 1650 };
    res = advanceHoldGate(state, sStalled, s2, targets, DEFAULT_ALIGNMENT_GATE);
    state = res.nextState;
    expect(res.shouldTrigger).toBe(false);
    expect(state.startMs).toBe(1650);

    // Continuous steady samples after stall reach 320ms and trigger
    const s3 = { yawDeg: 0.1, pitchDeg: 0, rollDeg: 0, timestampMs: 1820 };
    res = advanceHoldGate(state, s3, sStalled, targets, DEFAULT_ALIGNMENT_GATE);
    state = res.nextState;
    expect(res.shouldTrigger).toBe(false);

    const s4 = { yawDeg: 0.1, pitchDeg: 0, rollDeg: 0, timestampMs: 1980 };
    res = advanceHoldGate(state, s4, s3, targets, DEFAULT_ALIGNMENT_GATE);
    expect(res.shouldTrigger).toBe(true);
    expect(res.alignment.holdProgress).toBe(1);
  });
});
