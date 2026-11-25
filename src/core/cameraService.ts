import type { EulerOrientation } from './types';
import { createCameraPose, mulMat3Vec3 } from './cameraPose';

export interface CameraStreamHandle {
  stream: MediaStream | null;
  mode: 'live' | 'simulation';
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
  stop: () => void;
}

/**
 * Acquire rear wide-angle camera stream via WebRTC getUserMedia.
 * Explicitly distinguishes 'live' vs 'simulation' mode so live sessions never silently
 * fall back to synthetic frames.
 */
export async function startCameraStream(): Promise<CameraStreamHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      stream: null,
      mode: 'simulation',
      fovHorizontalDeg: 62,
      fovVerticalDeg: 48,
      stop: () => {},
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    return {
      stream,
      mode: 'live',
      fovHorizontalDeg: 60,
      fovVerticalDeg: 46,
      stop: () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      },
    };
  } catch {
    return {
      stream: null,
      mode: 'simulation',
      fovHorizontalDeg: 62,
      fovVerticalDeg: 48,
      stop: () => {},
    };
  }
}

/**
 * Capture a JPEG frame strictly according to camera mode:
 * - 'live': requires ready <video> element; throws if video stream is not ready (never fakes frames).
 * - 'simulation': renders orientation-consistent procedural 3D world using the exact same CameraPose.
 */
export function captureFrameStrict(
  mode: 'live' | 'simulation',
  videoEl: HTMLVideoElement | null,
  orientation: EulerOrientation,
  fovHorizontalDeg: number,
  fovVerticalDeg: number
): { dataUrl: string; width: number; height: number } {
  const width = 960;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }

  if (mode === 'live') {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0) {
      throw new Error('相机视频流尚未就绪，请稍候再试');
    }
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const targetAspect = width / height;
    const videoAspect = vw / vh;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    if (videoAspect > targetAspect) {
      sw = vh * targetAspect;
      sx = (vw - sw) * 0.5;
    } else {
      sh = vw / targetAspect;
      sy = (vh - sh) * 0.5;
    }
    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, width, height);
  } else {
    renderSimulatedWorldFrame(ctx, width, height, orientation, fovHorizontalDeg, fovVerticalDeg);
  }

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.9),
    width,
    height,
  };
}

/**
 * Render an orientation-consistent procedural 3D environment using the unified CameraPose
 * (`camToWorld` matrix) so simulated captures match HUD and stitcher geometry identically,
 * including non-zero yaw, pitch, and roll.
 */
function renderSimulatedWorldFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  orientation: EulerOrientation,
  fovH: number,
  fovV: number
): void {
  const img = ctx.createImageData(width, height);
  const buf = img.data;
  const deg2rad = Math.PI / 180;
  const tanH = Math.tan((fovH * 0.5) * deg2rad);
  const tanV = Math.tan((fovV * 0.5) * deg2rad);
  const pose = createCameraPose(orientation);

  // Sun direction at yaw=45°, pitch=28°
  const sunX = Math.sin(45 * deg2rad) * Math.cos(28 * deg2rad);
  const sunY = Math.sin(28 * deg2rad);
  const sunZ = -Math.cos(45 * deg2rad) * Math.cos(28 * deg2rad);

  for (let y = 0; y < height; y += 2) {
    const ny = (y / (height - 1)) * 2 - 1;
    const yc = -ny * tanV;
    for (let x = 0; x < width; x += 2) {
      const nx = (x / (width - 1)) * 2 - 1;
      const xc = nx * tanH;
      const zc = -1;

      const worldRay = mulMat3Vec3(pose.camToWorld, { x: xc, y: yc, z: zc });
      const invLen = 1 / Math.hypot(worldRay.x, worldRay.y, worldRay.z);
      const dx = worldRay.x * invLen;
      const dy = worldRay.y * invLen;
      const dz = worldRay.z * invLen;

      const worldYaw = Math.atan2(dx, -dz);
      const mountainHeight =
        0.06 +
        0.05 * Math.sin(worldYaw * 3.0 + 0.4) +
        0.03 * Math.cos(worldYaw * 7.0 - 1.1);

      let r = 0;
      let g = 0;
      let b = 0;

      if (dy > mountainHeight) {
        const t = Math.min(1, Math.max(0, (dy - mountainHeight) / 0.9));
        r = 28 * (1 - t) + 8 * t;
        g = 58 * (1 - t) + 18 * t;
        b = 112 * (1 - t) + 48 * t;

        const sunDot = Math.max(0, dx * sunX + dy * sunY + dz * sunZ);
        const halo = Math.pow(sunDot, 18);
        const core = Math.pow(sunDot, 220);
        r += halo * 180 + core * 255;
        g += halo * 110 + core * 230;
        b += halo * 60 + core * 180;
      } else if (dy > -0.02) {
        r = 18;
        g = 26;
        b = 44;
      } else {
        const gx = dx / Math.min(-0.02, dy);
        const gz = dz / Math.min(-0.02, dy);
        const gridLine =
          Math.abs(Math.sin(gx * Math.PI * 1.5)) < 0.08 ||
          Math.abs(Math.sin(gz * Math.PI * 1.5)) < 0.08;
        const distFade = Math.exp(-Math.hypot(gx, gz) * 0.12);
        r = 14 + (gridLine ? 24 * distFade : 0);
        g = 22 + (gridLine ? 140 * distFade : 0);
        b = 38 + (gridLine ? 175 * distFade : 0);
      }

      const cr = Math.min(255, Math.max(0, Math.round(r)));
      const cg = Math.min(255, Math.max(0, Math.round(g)));
      const cb = Math.min(255, Math.max(0, Math.round(b)));

      for (let dy2 = 0; dy2 < 2 && y + dy2 < height; dy2++) {
        for (let dx2 = 0; dx2 < 2 && x + dx2 < width; dx2++) {
          const idx = ((y + dy2) * width + (x + dx2)) * 4;
          buf[idx] = cr;
          buf[idx + 1] = cg;
          buf[idx + 2] = cb;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}
