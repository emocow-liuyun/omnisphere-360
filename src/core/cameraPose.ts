import type { EulerOrientation, Vec3 } from './types';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** 3x3 row-major rotation matrix */
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface CameraPose {
  orientation: EulerOrientation;
  /** Camera-to-world unit quaternion: R = Ry(-yaw) * Rx(+pitch) * Rz(-roll) */
  quat: Quat;
  /** Camera-to-world 3x3 matrix */
  camToWorld: Mat3;
  /** World-to-camera 3x3 matrix (transpose of camToWorld) */
  worldToCam: Mat3;
}

export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function conjugateQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function axisAngleQuat(ax: number, ay: number, az: number, angleRad: number): Quat {
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
}

/**
 * Single source of truth for camera rotation across HUD, lattice, simulator, and stitcher.
 * Matches Three.js `camera.rotation.set(pitchRad, -yawRad, -rollRad, 'YXZ')`:
 *   R_camToWorld = Ry(-yaw) * Rx(+pitch) * Rz(-roll)
 * At yaw=0, pitch=0, roll=0: optical axis (-Z_cam) points to (0, 0, -1).
 * At yaw=+90, pitch=0, roll=0: optical axis (-Z_cam) points to (+1, 0, 0).
 * At pitch=+90: optical axis (-Z_cam) points to (0, +1, 0) (zenith).
 */
export function quatFromEuler(yawDeg: number, pitchDeg: number, rollDeg: number): Quat {
  const qYaw = axisAngleQuat(0, 1, 0, -yawDeg * DEG_TO_RAD);
  const qPitch = axisAngleQuat(1, 0, 0, pitchDeg * DEG_TO_RAD);
  const qRoll = axisAngleQuat(0, 0, 1, -rollDeg * DEG_TO_RAD);
  return normalizeQuat(multiplyQuat(multiplyQuat(qYaw, qPitch), qRoll));
}

export function quatToMat3(q: Quat): Mat3 {
  const { x, y, z, w } = normalizeQuat(q);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

export function transposeMat3(m: Mat3): Mat3 {
  return [
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ];
}

export function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function createCameraPose(orientation: EulerOrientation): CameraPose {
  const quat = quatFromEuler(orientation.yawDeg, orientation.pitchDeg, orientation.rollDeg);
  const camToWorld = quatToMat3(quat);
  const worldToCam = transposeMat3(camToWorld);
  return {
    orientation,
    quat,
    camToWorld,
    worldToCam,
  };
}

/**
 * Shortest-arc SLERP between two unit quaternions (handles antipodal sign flip).
 */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  if (dot > 0.9995) {
    return normalizeQuat({
      x: a.x + t * (bx - a.x),
      y: a.y + t * (by - a.y),
      z: a.z + t * (bz - a.z),
      w: a.w + t * (bw - a.w),
    });
  }

  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  return normalizeQuat({
    x: s0 * a.x + s1 * bx,
    y: s0 * a.y + s1 * by,
    z: s0 * a.z + s1 * bz,
    w: s0 * a.w + s1 * bw,
  });
}

/**
 * Full 3D rotation angle in degrees between two camera poses (includes roll around optical axis).
 */
export function quatAngularDistanceDeg(a: Quat, b: Quat): number {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return 2 * Math.acos(dot) * RAD_TO_DEG;
}

/**
 * Extract Euler angles (yaw, pitch, roll) from a camera-to-world quaternion
 * matching R = Ry(-yaw) * Rx(+pitch) * Rz(-roll).
 */
export function eulerFromQuat(q: Quat): { yawDeg: number; pitchDeg: number; rollDeg: number } {
  const m = quatToMat3(q);
  // Optical axis in world is camToWorld * (0, 0, -1) = (-m[2], -m[5], -m[8])
  const ox = -m[2];
  const oy = -m[5];
  const oz = -m[8];

  const pitchRad = Math.asin(Math.max(-1, Math.min(1, oy)));
  let yawDeg = Math.atan2(ox, -oz) * RAD_TO_DEG;
  if (yawDeg < 0) yawDeg += 360;

  // Roll from camera right/up vectors; only within 0.08° of exact ±90° pole is cos(pitch) degenerate
  let rollDeg = 0;
  if (Math.abs(oy) < 0.999999) {
    rollDeg = Math.atan2(-m[3], m[4]) * RAD_TO_DEG;
  } else {
    // At exact zenith/nadir, preserve horizontal basis orientation via camera right vector (m[0], m[6])
    yawDeg = Math.atan2(m[6], m[0]) * RAD_TO_DEG;
    if (yawDeg < 0) yawDeg += 360;
    rollDeg = 0;
  }

  return {
    yawDeg,
    pitchDeg: pitchRad * RAD_TO_DEG,
    rollDeg,
  };
}
