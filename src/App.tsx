import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import {
  Camera,
  Compass,
  Lock,
  RotateCcw,
  Sparkles,
  Undo2,
  Unlock,
  Wand2,
} from 'lucide-react';
import type {
  AeAfStatus,
  AlignmentStatus,
  CaptureDensity,
  CapturedFrame,
  CaptureMode,
  CapturePhase,
  EulerOrientation,
  SphereTarget,
  StitchProgress,
  StitchResult,
} from './core/types';
import {
  advanceHoldGate,
  computeActualFrustumCoveragePercent,
  DEFAULT_ALIGNMENT_GATE,
  evaluateAlignment,
  generateSphereLattice,
  type HoldGateState,
} from './core/sphereLattice';
import { SensorFusionController } from './core/sensorFusion';
import {
  captureFrameStrict,
  startCameraStream,
  type CameraStreamHandle,
} from './core/cameraService';
import { OmniStitcher } from './core/stitcher/nativeBridge';
import { runPanoramaStitch } from './core/stitcher';
import { SphereCaptureHUD } from './components/SphereCaptureHUD';
import { GalaxyShutterButton } from './components/galaxy/GalaxyShutterButton';
import { GalaxyGlassPill } from './components/galaxy/GalaxyGlassPill';
import { GalaxyOrbitalLoader } from './components/galaxy/GalaxyOrbitalLoader';
import { GalaxyModeSwitch } from './components/galaxy/GalaxyModeSwitch';
import { GalaxyActionButton } from './components/galaxy/GalaxyActionButton';

const PanoramaViewer360 = lazy(() =>
  import('./components/PanoramaViewer360').then((m) => ({ default: m.PanoramaViewer360 }))
);

export function App() {
  const [mode, setMode] = useState<CaptureMode>('sphere360');
  const [density, setDensity] = useState<CaptureDensity>('standard30');
  const [phase, setPhase] = useState<CapturePhase>('IDLE');
  const [targets, setTargets] = useState<SphereTarget[]>(() =>
    generateSphereLattice('sphere360', 'standard30')
  );
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [aeAfStatus, setAeAfStatus] = useState<AeAfStatus>('unlocked');
  const [sensorSource, setSensorSource] = useState<'native' | 'web-imu' | 'virtual'>('virtual');
  const [cameraMode, setCameraMode] = useState<'live' | 'simulation'>('simulation');
  const [fov, setFov] = useState({ long: 68, h: 68, v: 53 });
  const [orientation, setOrientation] = useState<EulerOrientation>({
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    timestampMs: performance.now(),
  });
  const [alignment, setAlignment] = useState<AlignmentStatus>(() =>
    evaluateAlignment(
      { yawDeg: 0, pitchDeg: 0, rollDeg: 0, timestampMs: 0 },
      null,
      generateSphereLattice('sphere360', 'standard30'),
      0,
      DEFAULT_ALIGNMENT_GATE
    )
  );
  const [stitchProgress, setStitchProgress] = useState<StitchProgress | null>(null);
  const [stitchResult, setStitchResult] = useState<StitchResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraHandleRef = useRef<CameraStreamHandle | null>(null);
  const sensorRef = useRef<SensorFusionController | null>(null);

  // Session & atomic transaction refs
  const sessionIdRef = useRef(1);
  const activeCaptureSessionRef = useRef<number | null>(null);
  const phaseRef = useRef<CapturePhase>('IDLE');
  const modeRef = useRef<CaptureMode>(mode);
  const targetsRef = useRef<SphereTarget[]>(targets);
  const framesRef = useRef<CapturedFrame[]>(frames);
  const cameraModeRef = useRef<'live' | 'simulation'>('simulation');
  const fovRef = useRef(fov);
  const aeAfStatusRef = useRef<AeAfStatus>('unlocked');
  const orientationRef = useRef<EulerOrientation>(orientation);

  // Sensor-driven hold gate refs
  const prevSampleRef = useRef<EulerOrientation | null>(null);
  const holdStateRef = useRef<HoldGateState>({
    targetId: null,
    startMs: null,
  });

  phaseRef.current = phase;
  modeRef.current = mode;
  targetsRef.current = targets;
  framesRef.current = frames;
  cameraModeRef.current = cameraMode;
  fovRef.current = fov;
  aeAfStatusRef.current = aeAfStatus;

  const releaseAeAfLock = useCallback(async () => {
    if (aeAfStatusRef.current === 'locked') {
      await OmniStitcher.lockExposureAndFocus({ locked: false }).catch(() => {});
      setAeAfStatus('unlocked');
    }
  }, []);

  const triggerHaptic = useCallback(() => {
    void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(25);
      }
    });
  }, []);

  const startStitching = useCallback(
    async (capturedFrames: CapturedFrame[], expectedSessionId: number) => {
      if (sessionIdRef.current !== expectedSessionId) return;
      setPhase('STITCHING');
      setErrorMsg(null);
      await releaseAeAfLock();

      const jobId = `job-${expectedSessionId}-${Date.now()}`;
      try {
        const res = await runPanoramaStitch(capturedFrames, {
          jobId,
          outputWidth: 4096,
          jpegQuality: 0.92,
          warpMode: modeRef.current === 'wide180' ? 'cylindrical' : 'spherical',
          onProgress: (p) => {
            if (sessionIdRef.current === expectedSessionId) {
              setStitchProgress(p);
            }
          },
        });
        if (sessionIdRef.current !== expectedSessionId) return;
        setStitchResult(res);
        setPhase('VIEWING');
      } catch (err) {
        if (sessionIdRef.current !== expectedSessionId) return;
        setErrorMsg(err instanceof Error ? err.message : '全景拼接失败');
        setPhase('GUIDING');
      }
    },
    [releaseAeAfLock]
  );

  const captureTargetFrame = useCallback(
    async (
      target: SphereTarget | null,
      explicitPose?: EulerOrientation
    ) => {
      if (activeCaptureSessionRef.current !== null) return;
      const currentPhase = phaseRef.current;
      if (currentPhase !== 'GUIDING' && currentPhase !== 'HOLD_STEADY') return;

      const mySessionId = sessionIdRef.current;
      activeCaptureSessionRef.current = mySessionId;
      setPhase('CAPTURING');
      setErrorMsg(null);

      try {
        if (framesRef.current.length === 0 && aeAfStatusRef.current === 'unlocked') {
          try {
            const lockRes = await OmniStitcher.lockExposureAndFocus({ locked: true });
            if (sessionIdRef.current !== mySessionId) return;
            setAeAfStatus(
              lockRes.locked ? 'locked' : lockRes.supported ? 'unlocked' : 'unsupported'
            );
          } catch {
            if (sessionIdRef.current !== mySessionId) return;
            setAeAfStatus('unsupported');
          }
        }

        if (sessionIdRef.current !== mySessionId) return;

        // Read pose right at frame grab time (after any async AE/AF lock)
        const poseSnapshot: EulerOrientation = {
          ...(explicitPose && framesRef.current.length > 0
            ? explicitPose
            : orientationRef.current),
        };

        const snap = captureFrameStrict(
          cameraModeRef.current,
          videoRef.current,
          poseSnapshot,
          fovRef.current.long
        );

        if (sessionIdRef.current !== mySessionId) return;

        const evalNow = evaluateAlignment(
          poseSnapshot,
          null,
          targetsRef.current,
          0,
          DEFAULT_ALIGNMENT_GATE
        );
        const matchedTarget =
          target && evalNow.angularErrorDeg <= 12 ? target : null;

        const newFrame: CapturedFrame = {
          id: `frame-${Date.now()}-${matchedTarget?.id ?? 'free'}`,
          targetId: matchedTarget?.id ?? null,
          imageDataUrl: snap.dataUrl,
          width: snap.width,
          height: snap.height,
          orientation: poseSnapshot,
          fovHorizontalDeg: snap.fovHorizontalDeg,
          fovVerticalDeg: snap.fovVerticalDeg,
          capturedAtMs: Date.now(),
        };

        triggerHaptic();

        const nextTargets = matchedTarget
          ? targetsRef.current.map((t) =>
              t.id === matchedTarget.id ? { ...t, captured: true } : t
            )
          : targetsRef.current;
        const nextFrames = [...framesRef.current, newFrame];

        targetsRef.current = nextTargets;
        framesRef.current = nextFrames;
        setTargets(nextTargets);
        setFrames(nextFrames);
        holdStateRef.current = { targetId: null, startMs: null };

        const remaining = nextTargets.filter((t) => !t.captured);
        if (remaining.length === 0) {
          await startStitching(nextFrames, mySessionId);
        } else {
          setPhase('GUIDING');
          setAlignment(
            evaluateAlignment(poseSnapshot, null, nextTargets, 0, DEFAULT_ALIGNMENT_GATE)
          );
        }
      } catch (err) {
        if (sessionIdRef.current === mySessionId) {
          setErrorMsg(err instanceof Error ? err.message : '抓帧失败');
          setPhase('GUIDING');
        }
      } finally {
        if (activeCaptureSessionRef.current === mySessionId) {
          activeCaptureSessionRef.current = null;
        }
      }
    },
    [startStitching, triggerHaptic]
  );

  const captureTargetFrameRef = useRef(captureTargetFrame);
  captureTargetFrameRef.current = captureTargetFrame;

  // Initialize camera stream & sensor fusion once; drive hold gate strictly on incoming samples
  useEffect(() => {
    let active = true;
    const sensor = new SensorFusionController();
    sensorRef.current = sensor;

    const unsub = sensor.subscribe((next) => {
      if (!active) return;
      orientationRef.current = next;
      setOrientation(next);

      const prev = prevSampleRef.current;
      prevSampleRef.current = next;

      const curPhase = phaseRef.current;
      if (curPhase !== 'GUIDING' && curPhase !== 'HOLD_STEADY') {
        holdStateRef.current = { targetId: null, startMs: null };
        setAlignment(
          evaluateAlignment(next, prev, targetsRef.current, 0, DEFAULT_ALIGNMENT_GATE)
        );
        return;
      }

      const gate = advanceHoldGate(
        holdStateRef.current,
        next,
        prev,
        targetsRef.current,
        DEFAULT_ALIGNMENT_GATE
      );
      holdStateRef.current = gate.nextState;
      setAlignment(gate.alignment);

      if (gate.nextState.startMs !== null) {
        if (curPhase !== 'HOLD_STEADY') setPhase('HOLD_STEADY');
        if (gate.shouldTrigger && activeCaptureSessionRef.current === null) {
          void captureTargetFrameRef.current(gate.alignment.nearestTarget, next);
        }
      } else if (curPhase === 'HOLD_STEADY') {
        setPhase('GUIDING');
      }
    });

    (async () => {
      const cam = await startCameraStream();
      if (!active) {
        cam.stop();
        return;
      }
      cameraHandleRef.current = cam;
      setCameraMode(cam.mode);
      setFov({ long: cam.fovLongDeg, h: cam.fovHorizontalDeg, v: cam.fovVerticalDeg });
      if (videoRef.current && cam.stream) {
        videoRef.current.srcObject = cam.stream;
        await videoRef.current.play().catch(() => {});
      }

      const src = await sensor.start(false);
      if (active) {
        setSensorSource(src);
      }
    })();

    return () => {
      active = false;
      sessionIdRef.current++;
      activeCaptureSessionRef.current = null;
      unsub();
      cameraHandleRef.current?.stop();
      cameraHandleRef.current = null;
      void sensor.stop();
      void releaseAeAfLock();
    };
  }, [releaseAeAfLock]);

  // Re-bind live MediaStream whenever returning from VIEWING to camera view
  useEffect(() => {
    if (phase !== 'VIEWING' && cameraMode === 'live') {
      const stream = cameraHandleRef.current?.stream;
      const video = videoRef.current;
      if (video && stream && video.srcObject !== stream) {
        video.srcObject = stream;
        void video.play().catch(() => {});
      }
    }
  }, [phase, cameraMode]);

  // Reset lattice when mode or density changes in IDLE
  useEffect(() => {
    if (phase === 'IDLE') {
      const fresh = generateSphereLattice(mode, density);
      targetsRef.current = fresh;
      framesRef.current = [];
      setTargets(fresh);
      setFrames([]);
      setAlignment(
        evaluateAlignment(orientationRef.current, null, fresh, 0, DEFAULT_ALIGNMENT_GATE)
      );
    }
  }, [mode, density, phase]);

  const coveragePercent = useMemo(
    () => computeActualFrustumCoveragePercent(frames),
    [frames]
  );

  const capturedCount = useMemo(() => targets.filter((t) => t.captured).length, [targets]);

  const handleStartSession = async () => {
    setErrorMsg(null);
    if (sensorRef.current) {
      const perm = await sensorRef.current.requestPermissionIfNeeded();
      if (perm === 'granted') {
        const src = await sensorRef.current.start(false);
        setSensorSource(src);
      }
    }
    setPhase('GUIDING');
  };

  const handleUndoLast = () => {
    if (activeCaptureSessionRef.current !== null || phase === 'STITCHING' || frames.length === 0) {
      return;
    }
    const last = frames[frames.length - 1];
    const nextFrames = frames.slice(0, -1);
    const nextTargets = last.targetId
      ? targets.map((t) => (t.id === last.targetId ? { ...t, captured: false } : t))
      : targets;
    framesRef.current = nextFrames;
    targetsRef.current = nextTargets;
    setFrames(nextFrames);
    setTargets(nextTargets);
    if (nextFrames.length === 0) {
      void releaseAeAfLock();
    }
    holdStateRef.current = { targetId: null, startMs: null };
    setAlignment(
      evaluateAlignment(orientationRef.current, null, nextTargets, 0, DEFAULT_ALIGNMENT_GATE)
    );
  };

  const handleRestart = async () => {
    sessionIdRef.current++;
    activeCaptureSessionRef.current = null;
    const fresh = generateSphereLattice(mode, density);
    targetsRef.current = fresh;
    framesRef.current = [];
    setTargets(fresh);
    setFrames([]);
    setStitchResult(null);
    setStitchProgress(null);
    setErrorMsg(null);
    holdStateRef.current = { targetId: null, startMs: null };
    await releaseAeAfLock();
    setPhase('IDLE');
    setAlignment(
      evaluateAlignment(orientationRef.current, null, fresh, 0, DEFAULT_ALIGNMENT_GATE)
    );
  };

  const handleAimNextTarget = () => {
    if (!alignment.nearestTarget || !sensorRef.current) return;
    sensorRef.current.setVirtualGimbal(
      alignment.nearestTarget.yawDeg,
      alignment.nearestTarget.pitchDeg
    );
  };

  const handleAutoDemoCaptureAll = async () => {
    if (activeCaptureSessionRef.current !== null || phase === 'STITCHING' || !sensorRef.current) {
      return;
    }
    const mySessionId = ++sessionIdRef.current;
    setPhase('GUIDING');
    const freshTargets = generateSphereLattice(mode, density);
    const demoFrames: CapturedFrame[] = [];

    for (const t of freshTargets) {
      if (sessionIdRef.current !== mySessionId) return;
      const pose: EulerOrientation = {
        yawDeg: t.yawDeg,
        pitchDeg: t.pitchDeg,
        rollDeg: 0,
        timestampMs: performance.now(),
      };
      sensorRef.current.setVirtualGimbal(t.yawDeg, t.pitchDeg);
      const snap = captureFrameStrict(
        'simulation',
        null,
        pose,
        fovRef.current.long
      );
      demoFrames.push({
        id: `demo-${t.id}`,
        targetId: t.id,
        imageDataUrl: snap.dataUrl,
        width: snap.width,
        height: snap.height,
        orientation: pose,
        fovHorizontalDeg: snap.fovHorizontalDeg,
        fovVerticalDeg: snap.fovVerticalDeg,
        capturedAtMs: Date.now(),
      });
    }

    if (sessionIdRef.current !== mySessionId) return;
    const doneTargets = freshTargets.map((t) => ({ ...t, captured: true }));
    targetsRef.current = doneTargets;
    framesRef.current = demoFrames;
    setTargets(doneTargets);
    setFrames(demoFrames);
    await startStitching(demoFrames, mySessionId);
  };

  if (phase === 'VIEWING' && stitchResult) {
    return (
      <Suspense
        fallback={
          <div className="w-full h-full bg-[#05070d] flex items-center justify-center">
            <GalaxyOrbitalLoader
              progress={0.95}
              title="正在加载 360° 查看器"
              subtitle="初始化球面纹理..."
              engineLabel="THREE.JS SPHERE VIEWER"
            />
          </div>
        }
      >
        <PanoramaViewer360 result={stitchResult} onBackToCamera={() => void handleRestart()} />
      </Suspense>
    );
  }

  return (
    <div className="relative w-full h-full bg-[#05070d] overflow-hidden select-none">
      <video
        ref={videoRef}
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover ${
          cameraMode === 'simulation' ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      />

      {cameraMode === 'simulation' && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 50% 35%, rgba(30, 58, 138, 0.35), rgba(5, 7, 13, 0.96) 75%)',
          }}
        />
      )}

      <SphereCaptureHUD
        orientation={orientation}
        targets={targets}
        alignment={alignment}
        fovVerticalDeg={fov.v}
        isVirtualMode={sensorSource === 'virtual'}
        onVirtualDrag={(dyaw, dpitch) => sensorRef.current?.nudgeVirtualGimbal(dyaw, dpitch)}
      />

      <header className="absolute top-0 inset-x-0 z-20 p-4 pt-[max(1rem,var(--safe-top))] flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <GalaxyGlassPill>
            <Camera className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-semibold tracking-wide">OmniSphere 360</span>
          </GalaxyGlassPill>

          <GalaxyGlassPill>
            <Compass className="w-3.5 h-3.5 text-indigo-400" />
            <span className="tabular-nums">
              {Math.round(orientation.yawDeg)}° / {Math.round(orientation.pitchDeg)}°
            </span>
          </GalaxyGlassPill>
        </div>

        <div className="flex items-center gap-2 pointer-events-auto">
          <GalaxyGlassPill>
            {aeAfStatus === 'locked' ? (
              <Lock className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Unlock className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span>
              {aeAfStatus === 'locked'
                ? 'AE/AF 已锁定'
                : aeAfStatus === 'unsupported'
                  ? 'AE/AF 浏览器自动'
                  : 'AE/AF 自动'}
            </span>
          </GalaxyGlassPill>

          <GalaxyGlassPill>
            <span className="text-cyan-300 font-semibold tabular-nums">
              {capturedCount}/{targets.length}
            </span>
            <span className="text-slate-400">· 实测覆盖 {coveragePercent}%</span>
          </GalaxyGlassPill>
        </div>
      </header>

      {phase !== 'STITCHING' && (
        <div className="absolute top-20 inset-x-0 z-20 flex flex-col items-center gap-2 px-4 pointer-events-none">
          <GalaxyGlassPill className="border-cyan-400/25">
            <span
              className={`w-2 h-2 rounded-full ${
                alignment.isAligned ? 'bg-emerald-400 animate-ping' : 'bg-cyan-400'
              }`}
            />
            <span className="text-xs text-slate-100">
              {phase === 'IDLE'
                ? '点击下方快门开始无死角球面采集（含天顶与地面）'
                : alignment.guidanceHint}
            </span>
          </GalaxyGlassPill>

          {errorMsg && (
            <GalaxyGlassPill className="border-rose-400/40 text-rose-200">
              <span>{errorMsg}</span>
            </GalaxyGlassPill>
          )}
        </div>
      )}

      {phase === 'STITCHING' && (
        <div className="absolute inset-0 z-30 bg-slate-950/75 backdrop-blur-md flex items-center justify-center p-4">
          <GalaxyOrbitalLoader
            progress={stitchProgress?.progress ?? 0.1}
            title="正在合成无死角全景"
            subtitle={stitchProgress?.message ?? '准备球面投影与升余弦融合...'}
            engineLabel={
              stitchProgress?.engine === 'native-opencv'
                ? 'NATIVE OPENCV C++ ENGINE'
                : 'ON-DEVICE CPU/CANVAS STITCHER'
            }
          />
        </div>
      )}

      {phase !== 'STITCHING' && (
        <footer className="absolute bottom-0 inset-x-0 z-20 p-5 pb-[max(1.25rem,var(--safe-bottom))] flex flex-col items-center gap-4 pointer-events-none">
          {phase === 'IDLE' && (
            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
              <GalaxyModeSwitch
                ariaLabel="拍摄模式"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'sphere360', label: '360°×180° 无死角' },
                  { value: 'wide180', label: '180° 广角' },
                ]}
              />
              {mode === 'sphere360' && (
                <GalaxyModeSwitch
                  ariaLabel="采样密度"
                  value={density}
                  onChange={setDensity}
                  options={[
                    { value: 'fast26', label: '34 帧极速' },
                    { value: 'standard30', label: '40 帧标准' },
                    { value: 'ultra38', label: '48 帧超清' },
                  ]}
                />
              )}
            </div>
          )}

          {sensorSource === 'virtual' && (
            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
              {phase !== 'IDLE' && alignment.nearestTarget && (
                <GalaxyActionButton
                  icon={<Compass className="w-3.5 h-3.5 text-amber-300" />}
                  label="模拟对准下一点"
                  onClick={handleAimNextTarget}
                />
              )}
              <GalaxyActionButton
                icon={<Wand2 className="w-3.5 h-3.5 text-cyan-300" />}
                label="一键模拟全套采集并合成"
                variant="primary"
                onClick={() => void handleAutoDemoCaptureAll()}
              />
            </div>
          )}

          <div className="pointer-events-auto w-full max-w-md flex items-center justify-between px-4">
            <GalaxyActionButton
              icon={<Undo2 className="w-4 h-4" />}
              label="撤销"
              disabled={frames.length === 0 || phase === 'CAPTURING'}
              onClick={handleUndoLast}
            />

            <GalaxyShutterButton
              isCapturing={phase === 'CAPTURING'}
              isAligned={alignment.isAligned}
              holdProgress={phase === 'IDLE' ? 0 : alignment.holdProgress}
              disabled={phase === 'CAPTURING'}
              onClick={() => {
                if (phase === 'IDLE') {
                  void handleStartSession();
                } else {
                  void captureTargetFrame(alignment.nearestTarget);
                }
              }}
            />

            {frames.length >= 4 ? (
              <GalaxyActionButton
                icon={<Sparkles className="w-4 h-4" />}
                label="立即合成"
                variant="primary"
                disabled={phase === 'CAPTURING'}
                onClick={() => void startStitching(frames, sessionIdRef.current)}
              />
            ) : (
              <GalaxyActionButton
                icon={<RotateCcw className="w-4 h-4" />}
                label="重置"
                disabled={phase === 'IDLE' && frames.length === 0}
                onClick={() => void handleRestart()}
              />
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

export default App;
