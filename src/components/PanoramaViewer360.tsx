import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Download, Globe, RotateCw, Share2, Sparkles, ArrowLeft } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { StitchResult } from '../core/types';
import { GalaxyActionButton } from './galaxy/GalaxyActionButton';
import { GalaxyGlassPill } from './galaxy/GalaxyGlassPill';
import { GalaxyModeSwitch } from './galaxy/GalaxyModeSwitch';

interface PanoramaViewer360Props {
  result: StitchResult;
  onBackToCamera: () => void;
}

type ViewProjection = 'sphere' | 'wideOverview';

export const PanoramaViewer360: React.FC<PanoramaViewer360Props> = ({
  result,
  onBackToCamera,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [projection, setProjection] = useState<ViewProjection>('sphere');
  const [autoRotate, setAutoRotate] = useState(true);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // lon=180 faces u=0.5 (center of equirectangular image) on Three.js inverted SphereGeometry
  const viewStateRef = useRef({
    lon: 180,
    lat: 0,
    fov: 75,
    dragging: false,
    lastX: 0,
    lastY: 0,
    autoRotate: true,
  });

  useEffect(() => {
    viewStateRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    if (projection === 'wideOverview') {
      viewStateRef.current.lat = -78;
      viewStateRef.current.fov = 118;
    } else {
      viewStateRef.current.lat = 0;
      viewStateRef.current.fov = 75;
    }
  }, [projection]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      75,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      1100
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Map image onto exact spherical angular span derived from GPano fullPano & crop bounds
    const fullW = Math.max(1, result.fullPanoWidth);
    const fullH = Math.max(1, result.fullPanoHeight);
    const phiStart = (result.cropLeft / fullW) * Math.PI * 2;
    const phiLength = Math.min(Math.PI * 2, (result.width / fullW) * Math.PI * 2);
    const thetaStart = (result.cropTop / fullH) * Math.PI;
    const thetaLength = Math.min(Math.PI, (result.height / fullH) * Math.PI);

    const geometry = new THREE.SphereGeometry(
      500,
      64,
      40,
      phiStart,
      phiLength,
      thetaStart,
      thetaLength
    );
    geometry.scale(-1, 1, 1);

    const textureLoader = new THREE.TextureLoader();
    const texture = textureLoader.load(result.equirectangularDataUrl);
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const handleResize = () => {
      if (!container) return;
      camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    const target = new THREE.Vector3();
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const st = viewStateRef.current;
      if (st.autoRotate && !st.dragging) {
        st.lon += 0.12;
      }
      st.lat = Math.max(-89, Math.min(89, st.lat));
      const phi = THREE.MathUtils.degToRad(90 - st.lat);
      const theta = THREE.MathUtils.degToRad(st.lon);

      target.x = 500 * Math.sin(phi) * Math.cos(theta);
      target.y = 500 * Math.cos(phi);
      target.z = 500 * Math.sin(phi) * Math.sin(theta);

      if (Math.abs(camera.fov - st.fov) > 0.1) {
        camera.fov += (st.fov - camera.fov) * 0.12;
        camera.updateProjectionMatrix();
      }

      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [result.equirectangularDataUrl]);

  const handlePointerDown = (e: React.PointerEvent) => {
    viewStateRef.current.dragging = true;
    viewStateRef.current.lastX = e.clientX;
    viewStateRef.current.lastY = e.clientY;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!viewStateRef.current.dragging) return;
    const dx = e.clientX - viewStateRef.current.lastX;
    const dy = e.clientY - viewStateRef.current.lastY;
    viewStateRef.current.lastX = e.clientX;
    viewStateRef.current.lastY = e.clientY;
    viewStateRef.current.lon -= dx * 0.22;
    viewStateRef.current.lat += dy * 0.22;
  };

  const handlePointerUp = () => {
    viewStateRef.current.dragging = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    viewStateRef.current.fov = Math.max(
      35,
      Math.min(125, viewStateRef.current.fov + e.deltaY * 0.05)
    );
  };

  const handleDownloadOrSave = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        const fileName = `OmniSphere_360_${Date.now()}.jpg`;
        const base64 = result.equirectangularDataUrl.split(',')[1];
        await Filesystem.writeFile({
          path: fileName,
          data: base64,
          directory: Directory.Documents,
        });
        setExportStatus(`已保存至文档目录: ${fileName}`);
      } else {
        const a = document.createElement('a');
        a.href = result.equirectangularDataUrl;
        a.download = `OmniSphere_360_${Date.now()}.jpg`;
        a.click();
        setExportStatus('已导出含 GPano XMP 元数据的 360° JPEG');
      }
    } catch (err) {
      setExportStatus(`导出失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const handleShare = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        const fileName = `OmniSphere_Share_${Date.now()}.jpg`;
        const base64 = result.equirectangularDataUrl.split(',')[1];
        const written = await Filesystem.writeFile({
          path: fileName,
          data: base64,
          directory: Directory.Cache,
        });
        await Share.share({
          title: 'OmniSphere 360 全景照片',
          text: '使用 OmniSphere 360 拍摄的球面全景',
          url: written.uri,
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        const blob = new Blob([new Uint8Array(result.jpegBytes)], { type: 'image/jpeg' });
        const file = new File([blob], 'omnisphere-360.jpg', { type: 'image/jpeg' });
        if (navigator.canShare && !navigator.canShare({ files: [file] })) {
          await handleDownloadOrSave();
          return;
        }
        await navigator.share({
          title: 'OmniSphere 360 全景照片',
          files: [file],
        });
      } else {
        await handleDownloadOrSave();
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setExportStatus(`分享失败: ${err instanceof Error ? err.message : '当前环境不支持文件分享'}`);
    }
  };

  return (
    <div className="relative w-full h-full bg-[#05070d] overflow-hidden">
      <div
        ref={mountRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
      />

      <div className="absolute top-0 inset-x-0 z-20 p-4 pt-[max(1rem,var(--safe-top))] flex items-center justify-between gap-2 pointer-events-none">
        <div className="pointer-events-auto">
          <GalaxyActionButton
            icon={<ArrowLeft className="w-4 h-4" />}
            label="重拍"
            onClick={onBackToCamera}
          />
        </div>

        <GalaxyGlassPill className="pointer-events-auto">
          <Globe className="w-3.5 h-3.5 text-cyan-400" />
          <span>
            {result.width}×{result.height} · {result.usedFrameCount} 帧 · 覆盖{' '}
            {result.coveragePercent}% ·{' '}
            {result.engine === 'native-opencv' ? 'OpenCV 原生' : 'CPU/Canvas'}
          </span>
          {result.hasGpanoXmp && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
              {result.isFullSphere ? 'GPano 360°' : 'GPano 局部'}
            </span>
          )}
        </GalaxyGlassPill>
      </div>

      <div className="absolute bottom-0 inset-x-0 z-20 p-5 pb-[max(1.25rem,var(--safe-bottom))] flex flex-col items-center gap-3 pointer-events-none">
        {exportStatus && (
          <GalaxyGlassPill className="text-emerald-300 border-emerald-400/30">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{exportStatus}</span>
          </GalaxyGlassPill>
        )}

        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2.5">
          <GalaxyModeSwitch
            value={projection}
            onChange={setProjection}
            options={[
              { value: 'sphere', label: '360° 球面漫游' },
              { value: 'wideOverview', label: '广角俯瞰' },
            ]}
          />

          <GalaxyActionButton
            icon={<RotateCw className={`w-4 h-4 ${autoRotate ? 'animate-spin' : ''}`} />}
            label={autoRotate ? '自动巡航' : '手动拖拽'}
            active={autoRotate}
            onClick={() => setAutoRotate((v) => !v)}
          />

          <GalaxyActionButton
            icon={<Download className="w-4 h-4" />}
            label="保存全景"
            variant="primary"
            onClick={handleDownloadOrSave}
          />

          <GalaxyActionButton
            icon={<Share2 className="w-4 h-4" />}
            label="分享"
            onClick={handleShare}
          />
        </div>
      </div>
    </div>
  );
};
