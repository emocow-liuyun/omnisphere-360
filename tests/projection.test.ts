import { describe, expect, it } from 'vitest';
import { createCameraPose, mulMat3Vec3 } from '../src/core/cameraPose';
import { computeFovForDimensions } from '../src/core/cameraService';
import {
  equirectUVToWorldRay,
  projectWorldRayToFrameUV,
} from '../src/core/stitcher/webglStitcher';

describe('equirectangular projection & CameraPose round-trip math', () => {
  it('maps center of equirectangular image (0.5, 0.5) to forward ray (0, 0, -1)', () => {
    const ray = equirectUVToWorldRay(0.5, 0.5);
    expect(ray.x).toBeCloseTo(0, 5);
    expect(ray.y).toBeCloseTo(0, 5);
    expect(ray.z).toBeCloseTo(-1, 5);
  });

  it('projects optical axis ray to exact center (0.5, 0.5) for yaw=+90°, pitch=0°, roll=0°', () => {
    // yaw=+90° points optical axis to (+1, 0, 0)
    const proj = projectWorldRayToFrameUV(1, 0, 0, {
      yawDeg: 90,
      pitchDeg: 0,
      rollDeg: 0,
      fovHorizontalDeg: 60,
      fovVerticalDeg: 46,
    });
    expect(proj).not.toBeNull();
    expect(proj!.u).toBeCloseTo(0.5, 5);
    expect(proj!.v).toBeCloseTo(0.5, 5);
    expect(proj!.weight).toBeCloseTo(1.0, 5);
  });

  it('round-trips off-axis pixels accurately under combined non-zero yaw, pitch, and roll', () => {
    const cases = [
      { yawDeg: 90, pitchDeg: 34, rollDeg: 35 },
      { yawDeg: 215, pitchDeg: -45, rollDeg: -120 },
      { yawDeg: 355, pitchDeg: 66, rollDeg: 175 },
      { yawDeg: 0, pitchDeg: 90, rollDeg: 42 },
    ];
    const fovH = 60;
    const fovV = 46;
    const tanH = Math.tan((fovH * 0.5 * Math.PI) / 180);
    const tanV = Math.tan((fovV * 0.5 * Math.PI) / 180);

    for (const c of cases) {
      const pose = createCameraPose({ ...c, timestampMs: 1000 });
      for (const [nx, ny] of [
        [0, 0],
        [0.65, -0.45],
        [-0.7, 0.55],
      ]) {
        const camRay = { x: nx * tanH, y: -ny * tanV, z: -1 };
        const worldRay = mulMat3Vec3(pose.camToWorld, camRay);
        const len = Math.hypot(worldRay.x, worldRay.y, worldRay.z);
        const proj = projectWorldRayToFrameUV(
          worldRay.x / len,
          worldRay.y / len,
          worldRay.z / len,
          { ...c, fovHorizontalDeg: fovH, fovVerticalDeg: fovV }
        );
        expect(proj).not.toBeNull();
        expect(proj!.u).toBeCloseTo((nx + 1) * 0.5, 4);
        expect(proj!.v).toBeCloseTo((ny + 1) * 0.5, 4);
      }
    }
  });

  it('rejects rays behind the camera', () => {
    const proj = projectWorldRayToFrameUV(0, 0, 1, {
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      fovHorizontalDeg: 60,
      fovVerticalDeg: 46,
    });
    expect(proj).toBeNull();
  });

  it('computes consistent horizontal/vertical FOV for both landscape and portrait video streams', () => {
    const land = computeFovForDimensions(1080, 810, 68);
    expect(land.fovHorizontalDeg).toBeCloseTo(68, 4);
    expect(land.fovVerticalDeg).toBeCloseTo(53.67, 1);

    const port = computeFovForDimensions(810, 1080, 68);
    expect(port.fovVerticalDeg).toBeCloseTo(68, 4);
    expect(port.fovHorizontalDeg).toBeCloseTo(53.67, 1);
  });
});
