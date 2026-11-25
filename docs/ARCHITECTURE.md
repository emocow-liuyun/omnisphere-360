# OmniSphere 360 — 工程架构与跨平台构建指南

## 1. 方案选型与参考来源

本项目面向 **iOS 与 Android** 双端实现无死角（360°×180°）球面全景相机，综合了以下开源工程实践：

1. **球面引导采集与 GPano 元数据**：参考 `n30dyn4m1c/360-photo-app`，采用多环球面点阵（赤道 12 点 + 上环 +45° 8 点 + 下环 -45° 8 点 + 天顶 +88° + 天底 -88°，共 30 帧），结合角误差与角速度双门限自动触发快门，并在首帧锁定 AE/AF/AWB 防止接缝色差，最终向 JPEG APP1 段注入标准 `GPano` XMP 元数据。
2. **球内 3D HUD 与端侧 GPU 拼接**：参考斯坦福 `VFTCam`，使用 Three.js 将用户置于线框天球内部，直观呈现待拍点位与已覆盖区域；在 Web/PWA 或原生特征不足时，使用分带等距柱状反投影 + 亮度增益补偿 + 升余弦羽化融合完成离线拼接。
3. **跨平台原生 OpenCV 桥接**：参考 `notchip/expo-panoramic-stitcher`，通过 Capacitor 插件 `OmniStitcher` 暴露对称的 TypeScript 接口，iOS 端由 Swift + Objective-C++ 调用 `cv::Stitcher`（`SphericalWarper` + `BlocksGainCompensator` + `MultiBandBlender`），Android 端由 Kotlin + JNI C++17 静态链接 OpenCV 4.x。
4. **前端 UI 组件体系**：参考 `uiverse-io/galaxy` 的 CSS/Tailwind 开源组件风格，构建暗房磨砂玻璃胶囊（`GalaxyGlassPill`）、轨道进度快门（`GalaxyShutterButton`）、3D 轨道加载器（`GalaxyOrbitalLoader`）、分段模式切换器（`GalaxyModeSwitch`）与微交互按钮（`GalaxyActionButton`）。

## 2. 目录结构

```text
├── src/
│   ├── core/
│   │   ├── types.ts                  # 领域模型与状态机类型
│   │   ├── sphereLattice.ts          # 360°×180° 无死角点阵、测地线角距、稳定性门限、覆盖率采样
│   │   ├── sensorFusion.ts           # iOS/Android 原生 IMU、Web DeviceOrientation 与虚拟云台融合
│   │   ├── cameraService.ts          # WebRTC 相机流与程序化 3D 仿真环境采集
│   │   ├── gpanoXmp.ts               # 纯 TS JPEG APP1 GPano XMP 编码、注入与解析
│   │   └── stitcher/
│   │       ├── nativeBridge.ts       # Capacitor OmniStitcher 插件契约
│   │       ├── webglStitcher.ts      # 端侧分带球面反投影与升余弦羽化拼接器
│   │       └── index.ts              # 双引擎调度器（原生 OpenCV 优先，WebGL2/Canvas 自动回退）
│   ├── components/
│   │   ├── galaxy/                   # Uiverse Galaxy 风格 UI 组件库
│   │   ├── SphereCaptureHUD.tsx      # Three.js 球内引导 HUD 与光学准星
│   │   └── PanoramaViewer360.tsx     # 360° 球面漫游 / 小行星视角查看器与导出分享
│   └── App.tsx                       # 完整拍摄状态机与交互主控
├── native/
│   ├── ios/                          # Swift + Objective-C++ (AVFoundation + CoreMotion + OpenCV)
│   └── android/                      # Kotlin + JNI C++17 + CMake (SensorManager + OpenCV)
└── tests/                            # Vitest 单元测试（点阵覆盖率、投影数学、GPano XMP 二进制校验）
```

## 3. iOS 与 Android 原生工程集成步骤

1. 构建前端产物并初始化 Capacitor 原生工程：
   ```bash
   pnpm install
   pnpm build
   npx cap add ios
   npx cap add android
   ```
2. **iOS 端**：将 `native/ios/` 下的 `OmniStitcherPlugin.swift`、`OpenCVStitcher.h`、`OpenCVStitcher.mm` 加入 Xcode `App` Target，引入 `opencv2.xcframework`，并在 `Info.plist` 中声明 `NSCameraUsageDescription`、`NSMotionUsageDescription` 与 `NSPhotoLibraryAddUsageDescription`。
3. **Android 端**：将 `native/android/` 下的 `OmniStitcherPlugin.kt`、`stitcher_jni.cpp`、`CMakeLists.txt` 放入 `android/app/`，在 `build.gradle.kts` 配置 `externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt") } }` 并指向 OpenCV Android SDK，在 `AndroidManifest.xml` 声明 `CAMERA` 与 `HIGH_SAMPLING_RATE_SENSORS`。
4. 同步并运行：
   ```bash
   npx cap sync
   npx cap open ios
   npx cap open android
   ```
