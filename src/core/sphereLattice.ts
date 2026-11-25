import type {
  AlignmentStatus,
  CaptureDensity,
  CaptureMode,
  CapturedFrame,
  EulerOrientation,
  SphereTarget,
  Vec3,
} from './types';
import {
  createCameraPose,
  mulMat3Vec3,
  quatAngularDistanceDeg,
  quatFromEuler,
} from './cameraPose';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Convert yaw (deg, 0 = -Z forward, +90 = +X right) and pitch (deg, +90 = +Y zenith)
 * into a unit direction vector in world coordinates.
 */
export function eulerToDirection(yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = yawDeg * DEG_TO_RAD;
  const pitch = pitchDeg * DEG_TO_RAD;
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * Geodesic angular distance in degrees between two unit vectors on S^2.
 */
export function angularDistanceDeg(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * RAD_TO_DEG;
}

export function normalizeYawDeg(yawDeg: number): number {
  const mod = yawDeg % 360;
  return mod < 0 ? mod + 360 : mod;
}

export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  let delta = ((toDeg - fromDeg + 540) % 360) - 180;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Generate a true zero-blind-spot spherical target lattice for 60°x46° smartphone FOV.
 *
 * Ring pitch spacing is <= 34° (well below 46° vertical FOV) so adjacent rings overlap >= 26%
 * and leave zero blind spots anywhere on S^2, including the 68° crown band and poles:
 * - fast26 -> upgraded to 34 frames (10 equator + 8 upper34 + 3 crown68 + 1 zenith + 8 lower34 + 3 nadirCrown68 + 1 nadir)
 * - standard30 -> 40 frames (12 equator + 9 upper34 + 4 crown68 + 1 zenith + 9 lower34 + 4 nadirCrown68 + 1 nadir)
 * - ultra38 -> 48 frames (14 equator + 11 upper34 + 5 crown68 + 1 zenith + 11 lower34 + 5 nadirCrown68 + 1 nadir)
 */
export function generateSphereLattice(
  mode: CaptureMode = 'sphere360',
  density: CaptureDensity = 'standard30'
): SphereTarget[] {
  if (mode === 'wide180') {
    const targets: SphereTarget[] = [];
    let idx = 0;
    for (const yaw of [-75, -45, -15, 15, 45, 75]) {
      const normYaw = normalizeYawDeg(yaw);
      targets.push({
        id: `eq-${idx}`,
        index: idx++,
        ring: 'equator',
        yawDeg: normYaw,
        pitchDeg: 0,
        direction: eulerToDirection(normYaw, 0),
        captured: false,
      });
    }
    for (const yaw of [-60, -20, 20, 60]) {
      const normYaw = normalizeYawDeg(yaw);
      targets.push({
        id: `up-${idx}`,
        index: idx++,
        ring: 'upper',
        yawDeg: normYaw,
        pitchDeg: 32,
        direction: eulerToDirection(normYaw, 32),
        captured: false,
      });
    }
    return targets;
  }

  const cfg =
    density === 'fast26'
      ? { eq: 10, mid: 8, crown: 3 }
      : density === 'ultra38'
        ? { eq: 14, mid: 11, crown: 5 }
        : { eq: 12, mid: 9, crown: 4 };

  const targets: SphereTarget[] = [];
  let index = 0;

  // 1. Equator (0°)
  for (let i = 0; i < cfg.eq; i++) {
    const yawDeg = (i * 360) / cfg.eq;
    targets.push({
      id: `equator-${i}`,
      index: index++,
      ring: 'equator',
      yawDeg,
      pitchDeg: 0,
      direction: eulerToDirection(yawDeg, 0),
      captured: false,
    });
  }

  // 2. Upper mid ring (+34°)
  const midOffset = 180 / cfg.mid;
  for (let i = 0; i < cfg.mid; i++) {
    const yawDeg = normalizeYawDeg(i * (360 / cfg.mid) + midOffset);
    targets.push({
      id: `upper-${i}`,
      index: index++,
      ring: 'upper',
      yawDeg,
      pitchDeg: 34,
      direction: eulerToDirection(yawDeg, 34),
      captured: false,
    });
  }

  // 3. Upper crown ring (+66°) — eliminates the 68° blind-spot band
  const crownOffset = 180 / cfg.crown;
  for (let i = 0; i < cfg.crown; i++) {
    const yawDeg = normalizeYawDeg(i * (360 / cfg.crown) + crownOffset);
    targets.push({
      id: `upper-crown-${i}`,
      index: index++,
      ring: 'upper',
      yawDeg,
      pitchDeg: 66,
      direction: eulerToDirection(yawDeg, 66),
      captured: false,
    });
  }

  // 4. Zenith (+90°)
  targets.push({
    id: 'zenith-0',
    index: index++,
    ring: 'zenith',
    yawDeg: 0,
    pitchDeg: 90,
    direction: eulerToDirection(0, 90),
    captured: false,
  });

  // 5. Lower mid ring (-34°)
  for (let i = 0; i < cfg.mid; i++) {
    const yawDeg = normalizeYawDeg(i * (360 / cfg.mid) + midOffset);
    targets.push({
      id: `lower-${i}`,
      index: index++,
      ring: 'lower',
      yawDeg,
      pitchDeg: -34,
      direction: eulerToDirection(yawDeg, -34),
      captured: false,
    });
  }

  // 6. Lower crown ring (-66°)
  for (let i = 0; i < cfg.crown; i++) {
    const yawDeg = normalizeYawDeg(i * (360 / cfg.crown) + crownOffset);
    targets.push({
      id: `lower-crown-${i}`,
      index: index++,
      ring: 'lower',
      yawDeg,
      pitchDeg: -66,
      direction: eulerToDirection(yawDeg, -66),
      captured: false,
    });
  }

  // 7. Nadir (-90°)
  targets.push({
    id: 'nadir-0',
    index: index++,
    ring: 'nadir',
    yawDeg: 0,
    pitchDeg: -90,
    direction: eulerToDirection(0, -90),
    captured: false,
  });

  return targets;
}

export interface AlignmentGateConfig {
  alignThresholdDeg: number;
  maxAngularVelocityDegPerSec: number;
  holdDurationMs: number;
}

export const DEFAULT_ALIGNMENT_GATE: AlignmentGateConfig = {
  alignThresholdDeg: 6.5,
  maxAngularVelocityDegPerSec: 14.0,
  holdDurationMs: 320,
};

/**
 * Evaluate current camera orientation against remaining uncaptured targets.
 * Uses full 3D quaternion angular velocity (detects roll around optical axis too).
 */
export function evaluateAlignment(
  current: EulerOrientation,
  previous: EulerOrientation | null,
  targets: SphereTarget[],
  holdElapsedMs: number,
  config: AlignmentGateConfig = DEFAULT_ALIGNMENT_GATE
): AlignmentStatus {
  const remaining = targets.filter((t) => !t.captured);
  if (remaining.length === 0) {
    return {
      nearestTarget: null,
      angularErrorDeg: 0,
      angularVelocityDegPerSec: 0,
      isAligned: false,
      isSteady: true,
      holdProgress: 1,
      guidanceHint: '球面采集已完成，准备合成全景',
    };
  }

  const currentDir = eulerToDirection(current.yawDeg, current.pitchDeg);

  let nearestTarget = remaining[0];
  let minError = angularDistanceDeg(currentDir, nearestTarget.direction);

  for (let i = 1; i < remaining.length; i++) {
    const err = angularDistanceDeg(currentDir, remaining[i].direction);
    if (err < minError) {
      minError = err;
      nearestTarget = remaining[i];
    }
  }

  let angularVelocityDegPerSec = 0;
  if (previous && current.timestampMs > previous.timestampMs) {
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    const qPrev = quatFromEuler(previous.yawDeg, previous.pitchDeg, previous.rollDeg);
    const qCurr = quatFromEuler(current.yawDeg, current.pitchDeg, current.rollDeg);
    const movedDeg = quatAngularDistanceDeg(qPrev, qCurr);
    angularVelocityDegPerSec = movedDeg / Math.max(dtSec, 0.001);
  } else if (previous && current.timestampMs <= previous.timestampMs) {
    // Stale or duplicate timestamp cannot prove steadiness
    angularVelocityDegPerSec = config.maxAngularVelocityDegPerSec + 1;
  }

  const isAligned = minError <= config.alignThresholdDeg;
  const isSteady = angularVelocityDegPerSec <= config.maxAngularVelocityDegPerSec;
  const holdProgress =
    isAligned && isSteady ? Math.min(1, holdElapsedMs / config.holdDurationMs) : 0;

  let guidanceHint = '';
  if (isAligned && !isSteady) {
    guidanceHint = '已对准目标点，请稳住手机';
  } else if (isAligned && isSteady) {
    guidanceHint = '保持静止，正在自动触发快门';
  } else {
    const dYaw = shortestAngleDeltaDeg(current.yawDeg, nearestTarget.yawDeg);
    const dPitch = nearestTarget.pitchDeg - current.pitchDeg;
    if (Math.abs(dPitch) > Math.abs(dYaw) && Math.abs(dPitch) > 8) {
      guidanceHint = dPitch > 0 ? '向上抬起镜头对准光点' : '向下俯拍对准光点';
    } else {
      guidanceHint = dYaw > 0 ? '向右缓慢转动对准光点' : '向左缓慢转动对准光点';
    }
  }

  return {
    nearestTarget,
    angularErrorDeg: minError,
    angularVelocityDegPerSec,
    isAligned,
    isSteady,
    holdProgress,
    guidanceHint,
  };
}

export const MAX_SENSOR_GAP_MS = 250;

export interface HoldGateState {
  targetId: string | null;
  startMs: number | null;
}

/**
 * Pure sensor-driven hold gate transition:
 * - Resets hold if sensor stream stalled (> MAX_SENSOR_GAP_MS between samples)
 * - Resets hold if nearest target changed or alignment/steadiness broke
 * - Fires trigger=true once continuous steady hold reaches holdDurationMs
 */
export function advanceHoldGate(
  state: HoldGateState,
  next: EulerOrientation,
  prev: EulerOrientation | null,
  targets: SphereTarget[],
  config: AlignmentGateConfig = DEFAULT_ALIGNMENT_GATE
): {
  nextState: HoldGateState;
  alignment: AlignmentStatus;
  shouldTrigger: boolean;
} {
  const sampleGapMs = prev ? next.timestampMs - prev.timestampMs : 0;
  const workingState: HoldGateState =
    prev && sampleGapMs > MAX_SENSOR_GAP_MS ? { targetId: null, startMs: null } : state;

  const baseEval = evaluateAlignment(next, prev, targets, 0, config);
  if (!baseEval.isAligned || !baseEval.isSteady || !baseEval.nearestTarget) {
    return {
      nextState: { targetId: null, startMs: null },
      alignment: baseEval,
      shouldTrigger: false,
    };
  }

  const targetId = baseEval.nearestTarget.id;
  if (workingState.targetId !== targetId || workingState.startMs === null) {
    return {
      nextState: { targetId, startMs: next.timestampMs },
      alignment: baseEval,
      shouldTrigger: false,
    };
  }

  const elapsed = next.timestampMs - workingState.startMs;
  const alignment = evaluateAlignment(next, prev, targets, elapsed, config);
  return {
    nextState: workingState,
    alignment,
    shouldTrigger: elapsed >= config.holdDurationMs,
  };
}

/**
 * Compute ACTUAL spherical solid-angle coverage percentage [0, 100] by projecting
 * a 1,000-point Fibonacci sphere through every captured frame's real rectangular frustum
 * (using its recorded pose and FOV — no circular approximation and no 100% shortcut).
 */
export function computeActualFrustumCoveragePercent(
  frames: Pick<CapturedFrame, 'orientation' | 'fovHorizontalDeg' | 'fovVerticalDeg'>[],
  sampleCount = 1000
): number {
  if (frames.length === 0) return 0;

  const prepared = frames.map((f) => ({
    pose: createCameraPose(f.orientation),
    tanHalfH: Math.tan((f.fovHorizontalDeg * 0.5) * DEG_TO_RAD),
    tanHalfV: Math.tan((f.fovVerticalDeg * 0.5) * DEG_TO_RAD),
  }));

  let covered = 0;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < sampleCount; i++) {
    const y = 1 - (i / (sampleCount - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    const ray: Vec3 = {
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
    };

    for (let j = 0; j < prepared.length; j++) {
      const item = prepared[j];
      const camRay = mulMat3Vec3(item.pose.worldToCam, ray);
      if (camRay.z >= -0.05) continue;
      const nx = camRay.x / (-camRay.z * item.tanHalfH);
      const ny = -camRay.y / (-camRay.z * item.tanHalfV);
      if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) {
        covered++;
        break;
      }
    }
  }

  // Floor instead of round so 100% strictly means all 1000 Fibonacci samples are covered
  return Math.floor((covered / sampleCount) * 100);
}
