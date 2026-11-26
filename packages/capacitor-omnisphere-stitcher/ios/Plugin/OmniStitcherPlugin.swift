import Foundation
import Capacitor
import AVFoundation
import CoreMotion

@objc(OmniStitcherPlugin)
public class OmniStitcherPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OmniStitcherPlugin"
    public let jsName = "OmniStitcher"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isNativeStitcherAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCameraIntrinsics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lockExposureAndFocus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMotionUpdates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMotionUpdates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stitchPanorama", returnType: CAPPluginReturnPromise)
    ]

    private let motionManager = CMMotionManager()
    private let motionQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "com.omnisphere.motion"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private let cameraConfigQueue = DispatchQueue(label: "com.omnisphere.camera.config")
    private let stitchQueue = DispatchQueue(label: "com.omnisphere.stitcher", qos: .userInitiated)

    deinit {
        motionManager.stopDeviceMotionUpdates()
    }

    @objc func isNativeStitcherAvailable(_ call: CAPPluginCall) {
        call.resolve([
            "available": OpenCVStitcher.isAvailable(),
            "opencvVersion": OpenCVStitcher.openCVVersion()
        ])
    }

    @objc func getCameraIntrinsics(_ call: CAPPluginCall) {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            call.resolve([
                "available": false,
                "fovLongDeg": 68.0,
                "fovShortDeg": 53.0
            ])
            return
        }
        let fovLong = Double(device.activeFormat.videoFieldOfView)
        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let aspect = dims.width > 0 && dims.height > 0
            ? Double(min(dims.width, dims.height)) / Double(max(dims.width, dims.height))
            : 0.75
        let rad2deg = 180.0 / Double.pi
        let fovShort = 2.0 * atan(tan((fovLong * 0.5) / rad2deg) * aspect) * rad2deg
        call.resolve([
            "available": true,
            "fovLongDeg": fovLong,
            "fovShortDeg": fovShort
        ])
    }

    @objc func lockExposureAndFocus(_ call: CAPPluginCall) {
        let locked = call.getBool("locked") ?? true
        cameraConfigQueue.async {
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                call.resolve([
                    "locked": false,
                    "supported": false,
                    "aeLocked": false,
                    "afLocked": false,
                    "awbLocked": false
                ])
                return
            }

            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }

                var aeLocked = false
                var afLocked = false
                var awbLocked = false

                if locked {
                    if device.isExposureModeSupported(.locked) {
                        device.exposureMode = .locked
                        aeLocked = true
                    }
                    if device.isFocusModeSupported(.locked) {
                        device.focusMode = .locked
                        afLocked = true
                    }
                    if device.isWhiteBalanceModeSupported(.locked) {
                        device.whiteBalanceMode = .locked
                        awbLocked = true
                    }
                } else {
                    if device.isExposureModeSupported(.continuousAutoExposure) {
                        device.exposureMode = .continuousAutoExposure
                    }
                    if device.isFocusModeSupported(.continuousAutoFocus) {
                        device.focusMode = .continuousAutoFocus
                    }
                    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                        device.whiteBalanceMode = .continuousAutoWhiteBalance
                    }
                }

                call.resolve([
                    "locked": locked && (aeLocked || afLocked),
                    "supported": true,
                    "aeLocked": aeLocked,
                    "afLocked": afLocked,
                    "awbLocked": awbLocked
                ])
            } catch {
                call.reject("Failed to configure AE/AF lock: \(error.localizedDescription)")
            }
        }
    }

    @objc func startMotionUpdates(_ call: CAPPluginCall) {
        let rateHz = call.getDouble("rateHz") ?? 60.0
        guard motionManager.isDeviceMotionAvailable else {
            call.reject("CoreMotion DeviceMotion unavailable on this device")
            return
        }

        motionManager.stopDeviceMotionUpdates()
        motionManager.deviceMotionUpdateInterval = 1.0 / max(10.0, min(120.0, rateHz))
        motionManager.startDeviceMotionUpdates(
            using: .xArbitraryCorrectedZVertical,
            to: motionQueue
        ) { [weak self] motion, _ in
            guard let self = self, let motion = motion else { return }
            let m = motion.attitude.rotationMatrix

            // CMRotationMatrix maps reference -> device; transpose (rows) maps device -> reference.
            // Device back-camera optical axis in device frame is (0, 0, -1) -> -row3 = (-m31, -m32, -m33).
            let cmOptX = -m.m31
            let cmOptY = -m.m32
            let cmOptZ = -m.m33

            // Map CoreMotion world (X_cm, Y_cm, Z_cm) -> OmniSphere world (X = X_cm, Y = Z_cm, Z = -Y_cm)
            let wx = cmOptX
            let wy = cmOptZ
            let wz = -cmOptY

            let rad2deg = 180.0 / Double.pi
            let pitchDeg = max(-89.95, min(89.95, asin(max(-1.0, min(1.0, wy))) * rad2deg))
            var yawDeg = atan2(wx, -wz) * rad2deg
            if yawDeg < 0 { yawDeg += 360.0 }

            // Device right axis (1, 0, 0) -> row1 (m11, m12, m13); up axis (0, 1, 0) -> row2 (m21, m22, m23)
            // Only within ~0.08° of exact ±90° pole is cos(pitch) degenerate.
            let rightY = m.m13
            let upY = m.m23
            var rollDeg = 0.0
            if abs(wy) < 0.999999 {
                rollDeg = atan2(-rightY, upY) * rad2deg
            } else {
                // Preserve horizontal basis orientation via device right vector in OmniSphere world (m11, m13, -m12)
                yawDeg = atan2(-m.m12, m.m11) * rad2deg
                if yawDeg < 0 { yawDeg += 360.0 }
                rollDeg = 0.0
            }

            self.notifyListeners("orientationUpdate", data: [
                "yawDeg": yawDeg,
                "pitchDeg": pitchDeg,
                "rollDeg": rollDeg,
                "timestampMs": Int(motion.timestamp * 1000.0)
            ])
        }
        call.resolve()
    }

    @objc func stopMotionUpdates(_ call: CAPPluginCall) {
        motionManager.stopDeviceMotionUpdates()
        call.resolve()
    }

    @objc func stitchPanorama(_ call: CAPPluginCall) {
        guard let frames = call.getArray("frames", JSObject.self), !frames.isEmpty else {
            call.reject("frames array is required")
            return
        }

        let jobId = call.getString("jobId") ?? ""
        let outputWidth = call.getInt("outputWidth") ?? 4096
        let jpegQuality = call.getInt("jpegQuality") ?? 92
        let warpMode = call.getString("warpMode") ?? "spherical"
        let filePaths = frames.compactMap { $0["filePath"] as? String }
        let outputPath = call.getString("outputFilePath")
            ?? (NSTemporaryDirectory() + "omnisphere_\(UUID().uuidString).jpg")

        stitchQueue.async { [weak self] in
            guard let self = self else { return }
            let start = Date()

            self.notifyListeners("stitchProgress", data: [
                "jobId": jobId,
                "stage": "projecting",
                "progress": 0.25,
                "message": "OpenCV 正在执行球面特征匹配与光束平差..."
            ])

            var errorMessage: NSString?
            var usedIndices: NSArray = []
            var outW: Int = 0
            var outH: Int = 0
            // Objective-C BOOL* bridges as UnsafeMutablePointer<ObjCBool>, not <Bool>
            var isFullSphere: ObjCBool = false

            let ok = OpenCVStitcher.stitchImages(
                atPaths: filePaths,
                outputPath: outputPath,
                targetWidth: outputWidth,
                jpegQuality: jpegQuality,
                spherical: warpMode == "spherical",
                usedIndices: &usedIndices,
                outWidth: &outW,
                outHeight: &outH,
                isFullSphere: &isFullSphere,
                error: &errorMessage
            )

            if ok {
                let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
                self.notifyListeners("stitchProgress", data: [
                    "jobId": jobId,
                    "stage": "done",
                    "progress": 1.0,
                    "message": "原生 OpenCV 拼接完成"
                ])
                call.resolve([
                    "outputPath": outputPath,
                    "width": outW,
                    "height": outH,
                    "isFullSphere": isFullSphere.boolValue,
                    "usedIndices": usedIndices,
                    "elapsedMs": elapsedMs
                ])
            } else {
                call.reject((errorMessage as String?) ?? "OpenCV stitching failed")
            }
        }
    }
}
