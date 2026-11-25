import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AlignmentStatus, EulerOrientation, SphereTarget } from '../core/types';
import { eulerToDirection } from '../core/sphereLattice';

interface SphereCaptureHUDProps {
  orientation: EulerOrientation;
  targets: SphereTarget[];
  alignment: AlignmentStatus;
  fovVerticalDeg: number;
  isVirtualMode: boolean;
  onVirtualDrag?: (deltaYawDeg: number, deltaPitchDeg: number) => void;
}

/**
 * Three.js inside-sphere 3D guidance HUD.
 * Uses the exact same YXZ Euler convention and vertical FOV as the capture & stitch pipeline.
 */
export const SphereCaptureHUD: React.FC<SphereCaptureHUDProps> = ({
  orientation,
  targets,
  alignment,
  fovVerticalDeg,
  isVirtualMode,
  onVirtualDrag,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const nodeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const builtLayoutKeyRef = useRef<string>('');
  const ringGroupRef = useRef<THREE.Group | null>(null);
  const dragStateRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      fovVerticalDeg,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      200
    );
    camera.rotation.order = 'YXZ';
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const sphereGeo = new THREE.SphereGeometry(40, 24, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.14,
      side: THREE.BackSide,
    });
    const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
    scene.add(sphereMesh);

    const eqGeo = new THREE.RingGeometry(39.4, 39.7, 72);
    const eqMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    const eqRing = new THREE.Mesh(eqGeo, eqMat);
    eqRing.rotation.x = Math.PI / 2;
    scene.add(eqRing);

    const group = new THREE.Group();
    ringGroupRef.current = group;
    builtLayoutKeyRef.current = '';
    scene.add(group);

    const handleResize = () => {
      if (!container) return;
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      for (const mesh of nodeMeshesRef.current.values()) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      nodeMeshesRef.current.clear();
      builtLayoutKeyRef.current = '';
      ringGroupRef.current = null;
      cameraRef.current = null;
      sphereGeo.dispose();
      sphereMat.dispose();
      eqGeo.dispose();
      eqMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    const cam = cameraRef.current;
    if (cam && Math.abs(cam.fov - fovVerticalDeg) > 0.1) {
      cam.fov = fovVerticalDeg;
      cam.updateProjectionMatrix();
    }
  }, [fovVerticalDeg]);

  useEffect(() => {
    const group = ringGroupRef.current;
    if (!group) return;

    const layoutKey = targets.map((t) => t.id).join('|');
    if (builtLayoutKeyRef.current !== layoutKey) {
      for (const mesh of nodeMeshesRef.current.values()) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      nodeMeshesRef.current.clear();

      const radius = 36;
      for (const t of targets) {
        const geo = new THREE.SphereGeometry(1.15, 16, 16);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.85,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const dir = eulerToDirection(t.yawDeg, t.pitchDeg);
        mesh.position.set(dir.x * radius, dir.y * radius, dir.z * radius);
        group.add(mesh);
        nodeMeshesRef.current.set(t.id, mesh);
      }
      builtLayoutKeyRef.current = layoutKey;
    }

    for (const t of targets) {
      const mesh = nodeMeshesRef.current.get(t.id);
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const isNearest = alignment.nearestTarget?.id === t.id;

      if (t.captured) {
        mat.color.setHex(0x34d399);
        mat.opacity = 0.55;
        mesh.scale.setScalar(0.72);
      } else if (isNearest) {
        mat.color.setHex(alignment.isAligned ? 0x34d399 : 0xfbbf24);
        mat.opacity = 1.0;
        mesh.scale.setScalar(alignment.isAligned ? 1.45 : 1.25);
      } else {
        mat.color.setHex(0x38bdf8);
        mat.opacity = 0.78;
        mesh.scale.setScalar(1.0);
      }
    }
  }, [targets, alignment.nearestTarget?.id, alignment.isAligned]);

  useEffect(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const deg2rad = Math.PI / 180;
    cam.rotation.set(
      orientation.pitchDeg * deg2rad,
      -orientation.yawDeg * deg2rad,
      -orientation.rollDeg * deg2rad,
      'YXZ'
    );
  }, [orientation]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!isVirtualMode || !onVirtualDrag) return;
    dragStateRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStateRef.current.active || !onVirtualDrag) return;
    const dx = e.clientX - dragStateRef.current.lastX;
    const dy = e.clientY - dragStateRef.current.lastY;
    dragStateRef.current.lastX = e.clientX;
    dragStateRef.current.lastY = e.clientY;
    onVirtualDrag(-dx * 0.28, dy * 0.28);
  };

  const handlePointerUp = () => {
    dragStateRef.current.active = false;
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`absolute inset-0 z-10 touch-none ${
        isVirtualMode ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className={`relative w-16 h-16 rounded-full border-2 transition-all duration-150 flex items-center justify-center ${
            alignment.isAligned
              ? 'border-emerald-400 scale-110 shadow-[0_0_24px_rgba(52,211,153,0.6)]'
              : 'border-cyan-300/70 scale-100 shadow-[0_0_14px_rgba(34,211,238,0.25)]'
          }`}
        >
          <div
            className={`w-2 h-2 rounded-full transition-colors ${
              alignment.isAligned ? 'bg-emerald-400' : 'bg-cyan-300'
            }`}
          />
          <div
            className="absolute inset-x-[-14px] h-[1.5px] bg-gradient-to-r from-cyan-400/70 via-transparent to-cyan-400/70"
            style={{ transform: `rotate(${-orientation.rollDeg}deg)` }}
          />
        </div>
      </div>
    </div>
  );
};
