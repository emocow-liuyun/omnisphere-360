import { Capacitor } from '@capacitor/core';
import type { EulerOrientation } from './types';
import { eulerFromQuat, quatFromEuler, slerpQuat, type Quat } from './cameraPose';
import { normalizeYawDeg } from './sphereLattice';
import { OmniStitcher } from './stitcher/nativeBridge';

export type OrientationListener = (orientation: EulerOrientation) => void;

/**
 * Cross-platform sensor fusion controller:
 * - Native iOS/Android: subscribes to CoreMotion / RotationVector via OmniStitcher plugin
 * - Mobile Web / PWA: normalizes DeviceOrientationEvent (handling iOS permission prompt)
 * - Desktop / Simulator: virtual gimbal drag/aim control
 *
 * Uses unit quaternion SLERP internally so filtering is continuous across ±180° yaw,
 * ±180° roll, and zenith/nadir poles.
 */
export class SensorFusionController {
  private listeners = new Set<OrientationListener>();
  private running = false;
  private generation = 0;
  private useVirtualGimbal = false;
  private virtualOrientation: EulerOrientation = {
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    timestampMs: performance.now(),
  };
  private nativeListenerHandle: { remove: () => Promise<void> } | null = null;
  private webHandler: ((e: DeviceOrientationEvent) => void) | null = null;
  private smoothedQuat: Quat | null = null;
  private lastTimestampMs = 0;

  subscribe(listener: OrientationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(orientation: EulerOrientation): void {
    for (const listener of this.listeners) {
      listener(orientation);
    }
  }

  async requestPermissionIfNeeded(): Promise<'granted' | 'denied' | 'not-required'> {
    if (Capacitor.isNativePlatform()) {
      return 'not-required';
    }
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        return res === 'granted' ? 'granted' : 'denied';
      } catch {
        return 'denied';
      }
    }
    return 'not-required';
  }

  async start(preferVirtual = false): Promise<'native' | 'web-imu' | 'virtual'> {
    await this.stop();
    const myGen = ++this.generation;
    this.running = true;
    this.smoothedQuat = null;
    this.lastTimestampMs = 0;

    if (!preferVirtual && Capacitor.isNativePlatform()) {
      try {
        const handle = await OmniStitcher.addListener('orientationUpdate', (data) => {
          if (this.generation !== myGen || !this.running) return;
          this.pushRawSample(data.yawDeg, data.pitchDeg, data.rollDeg, data.timestampMs);
        });
        if (this.generation !== myGen || !this.running) {
          await handle.remove().catch(() => {});
          return 'virtual';
        }
        this.nativeListenerHandle = handle;
        await OmniStitcher.startMotionUpdates({ rateHz: 60 });
        if (this.generation !== myGen || !this.running) {
          await this.stop();
          return 'virtual';
        }
        this.useVirtualGimbal = false;
        return 'native';
      } catch {
        await this.cleanupNative();
      }
    }

    if (!preferVirtual && typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
      const hasRealSensor = await this.probeWebSensor(450, myGen);
      if (this.generation !== myGen || !this.running) {
        return 'virtual';
      }
      if (hasRealSensor) {
        this.webHandler = (event: DeviceOrientationEvent) => {
          if (this.generation !== myGen || !this.running) return;
          const parsed = normalizeWebDeviceOrientation(event);
          if (parsed) {
            this.pushRawSample(parsed.yawDeg, parsed.pitchDeg, parsed.rollDeg, performance.now());
          }
        };
        window.addEventListener('deviceorientation', this.webHandler, true);
        this.useVirtualGimbal = false;
        return 'web-imu';
      }
    }

    this.useVirtualGimbal = true;
    this.emit({ ...this.virtualOrientation, timestampMs: performance.now() });
    return 'virtual';
  }

  private probeWebSensor(timeoutMs: number, expectedGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const onEvent = (e: DeviceOrientationEvent) => {
        if (this.generation !== expectedGen) {
          cleanup(false);
          return;
        }
        if (e.alpha !== null && e.beta !== null && !settled) {
          cleanup(true);
        }
      };
      const timer = setTimeout(() => cleanup(false), timeoutMs);
      const cleanup = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('deviceorientation', onEvent, true);
        resolve(result);
      };
      window.addEventListener('deviceorientation', onEvent, true);
    });
  }

  private pushRawSample(
    yawDeg: number,
    pitchDeg: number,
    rollDeg: number,
    rawTimestampMs: number
  ): void {
    const ts = Math.max(this.lastTimestampMs + 1, rawTimestampMs);
    this.lastTimestampMs = ts;

    const rawQuat = quatFromEuler(yawDeg, clampPitch(pitchDeg), rollDeg);
    if (!this.smoothedQuat) {
      this.smoothedQuat = rawQuat;
    } else {
      this.smoothedQuat = slerpQuat(this.smoothedQuat, rawQuat, 0.35);
    }

    const euler = eulerFromQuat(this.smoothedQuat);
    this.emit({
      yawDeg: euler.yawDeg,
      pitchDeg: clampPitch(euler.pitchDeg),
      rollDeg: euler.rollDeg,
      timestampMs: ts,
    });
  }

  nudgeVirtualGimbal(deltaYawDeg: number, deltaPitchDeg: number): void {
    const ts = Math.max(this.lastTimestampMs + 1, performance.now());
    this.lastTimestampMs = ts;
    this.virtualOrientation = {
      yawDeg: normalizeYawDeg(this.virtualOrientation.yawDeg + deltaYawDeg),
      pitchDeg: clampPitch(this.virtualOrientation.pitchDeg + deltaPitchDeg),
      rollDeg: 0,
      timestampMs: ts,
    };
    this.emit({ ...this.virtualOrientation });
  }

  setVirtualGimbal(yawDeg: number, pitchDeg: number): void {
    const ts = Math.max(this.lastTimestampMs + 1, performance.now());
    this.lastTimestampMs = ts;
    this.virtualOrientation = {
      yawDeg: normalizeYawDeg(yawDeg),
      pitchDeg: clampPitch(pitchDeg),
      rollDeg: 0,
      timestampMs: ts,
    };
    this.emit({ ...this.virtualOrientation });
  }

  isVirtualMode(): boolean {
    return this.useVirtualGimbal;
  }

  private async cleanupNative(): Promise<void> {
    if (this.nativeListenerHandle) {
      const h = this.nativeListenerHandle;
      this.nativeListenerHandle = null;
      await h.remove().catch(() => {});
    }
    if (Capacitor.isNativePlatform()) {
      await OmniStitcher.stopMotionUpdates().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.running = false;
    await this.cleanupNative();
    if (this.webHandler) {
      window.removeEventListener('deviceorientation', this.webHandler, true);
      this.webHandler = null;
    }
  }
}

function clampPitch(pitch: number): number {
  return Math.max(-89.9, Math.min(89.9, pitch));
}

/**
 * Normalize browser DeviceOrientationEvent (portrait handheld camera pose)
 * into world yaw [0, 360) and pitch [-90, +90].
 */
export function normalizeWebDeviceOrientation(
  event: DeviceOrientationEvent
): { yawDeg: number; pitchDeg: number; rollDeg: number } | null {
  if (event.alpha === null || event.beta === null || event.gamma === null) {
    return null;
  }
  const webkitHeading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
    .webkitCompassHeading;

  const yawDeg =
    typeof webkitHeading === 'number' && !Number.isNaN(webkitHeading)
      ? normalizeYawDeg(webkitHeading)
      : normalizeYawDeg(360 - event.alpha);

  const pitchDeg = clampPitch(event.beta - 90);
  const rollDeg = event.gamma;

  return { yawDeg, pitchDeg, rollDeg };
}
