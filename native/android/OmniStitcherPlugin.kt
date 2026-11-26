package com.omnisphere.camera360

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.HandlerThread
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atan2

@CapacitorPlugin(name = "OmniStitcher")
class OmniStitcherPlugin : Plugin(), SensorEventListener {

    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null
    private var sensorThread: HandlerThread? = null
    private var sensorHandler: Handler? = null
    private val stitchExecutor = Executors.newSingleThreadExecutor()
    private val rotationMatrix = FloatArray(9)
    private var lastEmitNs: Long = 0L

    companion object {
        private var nativeLoaded = false

        init {
            try {
                System.loadLibrary("omnisphere_stitcher")
                nativeLoaded = true
            } catch (_: UnsatisfiedLinkError) {
                nativeLoaded = false
            }
        }
    }

    private external fun nativeGetOpenCVVersion(): String
    private external fun nativeStitchPanorama(
        inputPaths: Array<String>,
        outputPath: String,
        targetWidth: Int,
        jpegQuality: Int,
        spherical: Boolean
    ): IntArray

    override fun handleOnDestroy() {
        stopSensorInternal()
        stitchExecutor.shutdownNow()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun isNativeStitcherAvailable(call: PluginCall) {
        val res = JSObject()
        res.put("available", nativeLoaded)
        res.put("opencvVersion", if (nativeLoaded) nativeGetOpenCVVersion() else "not-linked")
        call.resolve(res)
    }

    @PluginMethod
    fun getCameraIntrinsics(call: PluginCall) {
        try {
            val camMgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            for (id in camMgr.cameraIdList) {
                val chars = camMgr.getCameraCharacteristics(id)
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                    val focalLengths = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                    val sensorSize = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                    if (focalLengths != null && focalLengths.isNotEmpty() && sensorSize != null && sensorSize.width > 0f && sensorSize.height > 0f) {
                        val f = focalLengths[0].toDouble()
                        val longSide = maxOf(sensorSize.width, sensorSize.height).toDouble()
                        val shortSide = minOf(sensorSize.width, sensorSize.height).toDouble()
                        val rad2deg = 180.0 / Math.PI
                        val fovLongDeg = 2.0 * atan(longSide / (2.0 * f)) * rad2deg
                        val fovShortDeg = 2.0 * atan(shortSide / (2.0 * f)) * rad2deg
                        val res = JSObject()
                        res.put("available", true)
                        res.put("fovLongDeg", fovLongDeg)
                        res.put("fovShortDeg", fovShortDeg)
                        call.resolve(res)
                        return
                    }
                }
            }
        } catch (_: Throwable) {
            // Fall through to default
        }
        val res = JSObject()
        res.put("available", false)
        res.put("fovLongDeg", 68.0)
        res.put("fovShortDeg", 53.0)
        call.resolve(res)
    }

    @PluginMethod
    fun lockExposureAndFocus(call: PluginCall) {
        val res = JSObject()
        res.put("locked", false)
        res.put("supported", false)
        res.put("aeLocked", false)
        res.put("afLocked", false)
        res.put("awbLocked", false)
        call.resolve(res)
    }

    @PluginMethod
    fun startMotionUpdates(call: PluginCall) {
        val rateHz = (call.getInt("rateHz", 60) ?: 60).coerceIn(10, 200)
        val mgr = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = mgr.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            ?: mgr.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        if (sensor == null) {
            call.reject("Rotation vector sensor unavailable")
            return
        }

        stopSensorInternal()
        sensorManager = mgr
        rotationSensor = sensor

        val thread = HandlerThread("OmniSphereSensorThread").apply { start() }
        val handler = Handler(thread.looper)
        sensorThread = thread
        sensorHandler = handler

        val periodUs = 1_000_000 / rateHz
        val registered = mgr.registerListener(this, sensor, periodUs, handler)
        if (!registered) {
            stopSensorInternal()
            call.reject("Failed to register rotation vector listener")
            return
        }
        call.resolve()
    }

    @PluginMethod
    fun stopMotionUpdates(call: PluginCall) {
        stopSensorInternal()
        call.resolve()
    }

    private fun stopSensorInternal() {
        sensorManager?.unregisterListener(this)
        sensorThread?.quitSafely()
        sensorThread = null
        sensorHandler = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_GAME_ROTATION_VECTOR &&
            event.sensor.type != Sensor.TYPE_ROTATION_VECTOR
        ) return
        if (event.timestamp - lastEmitNs < 16_000_000L) return
        lastEmitNs = event.timestamp

        // R maps device coordinates (X=right, Y=top, Z=out of screen) to Android world (East, North, Up).
        // Back-camera optical axis in device frame is (0, 0, -1) -> (-R[2], -R[5], -R[8]) in Android world.
        // Map Android world (East, North, Up) -> OmniSphere world (X=East, Y=Up, Z=-North):
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        val wx = -rotationMatrix[2].toDouble()
        val wy = -rotationMatrix[8].toDouble()
        val wz = rotationMatrix[5].toDouble()

        val rad2deg = 180.0 / Math.PI
        val pitchDeg = (asin(wy.coerceIn(-1.0, 1.0)) * rad2deg).coerceIn(-89.95, 89.95)
        var yawDeg = atan2(wx, -wz) * rad2deg
        if (yawDeg < 0) yawDeg += 360.0

        // Device right (1,0,0) -> (R[0], R[3], R[6]); device up (0,1,0) -> (R[1], R[4], R[7]).
        // Their OmniSphere world Y components are R[6] and R[7].
        val rightY = rotationMatrix[6].toDouble()
        val upY = rotationMatrix[7].toDouble()
        var rollDeg = 0.0
        if (abs(wy) < 0.999999) {
            rollDeg = atan2(-rightY, upY) * rad2deg
        } else {
            yawDeg = atan2(-rotationMatrix[3].toDouble(), rotationMatrix[0].toDouble()) * rad2deg
            if (yawDeg < 0) yawDeg += 360.0
            rollDeg = 0.0
        }

        val payload = JSObject()
        payload.put("yawDeg", yawDeg)
        payload.put("pitchDeg", pitchDeg)
        payload.put("rollDeg", rollDeg)
        payload.put("timestampMs", event.timestamp / 1_000_000L)
        notifyListeners("orientationUpdate", payload)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    @PluginMethod
    fun stitchPanorama(call: PluginCall) {
        if (!nativeLoaded) {
            call.reject("Native OpenCV JNI library not loaded")
            return
        }

        val frames = call.getArray("frames")
        if (frames == null || frames.length() == 0) {
            call.reject("frames array is required")
            return
        }

        val jobId = call.getString("jobId", "") ?: ""
        val paths = mutableListOf<String>()
        for (i in 0 until frames.length()) {
            val obj = frames.getJSONObject(i)
            val p = obj.optString("filePath", "")
            if (p.isNotEmpty()) paths.add(p)
        }

        val outputWidth = call.getInt("outputWidth", 4096) ?: 4096
        val jpegQuality = call.getInt("jpegQuality", 92) ?: 92
        val warpMode = call.getString("warpMode", "spherical") ?: "spherical"
        val outputPath = call.getString("outputFilePath")
            ?: File(context.cacheDir, "omnisphere_${UUID.randomUUID()}.jpg").absolutePath

        stitchExecutor.execute {
            try {
                val startMs = System.currentTimeMillis()
                val progress = JSObject()
                progress.put("jobId", jobId)
                progress.put("stage", "projecting")
                progress.put("progress", 0.25)
                progress.put("message", "OpenCV JNI 正在执行球面特征匹配与多频融合...")
                notifyListeners("stitchProgress", progress)

                val resultMeta = nativeStitchPanorama(
                    paths.toTypedArray(),
                    outputPath,
                    outputWidth,
                    jpegQuality,
                    warpMode == "spherical"
                )

                if (resultMeta.size >= 5 && resultMeta[0] == 1) {
                    val usedCount = resultMeta[1]
                    val outW = resultMeta[2]
                    val outH = resultMeta[3]
                    val isFullSphere = resultMeta[4] == 1
                    val indices = JSArray()
                    for (k in 0 until usedCount) {
                        if (5 + k < resultMeta.size) {
                            indices.put(resultMeta[5 + k])
                        }
                    }

                    val done = JSObject()
                    done.put("jobId", jobId)
                    done.put("stage", "done")
                    done.put("progress", 1.0)
                    done.put("message", "原生 OpenCV 拼接完成")
                    notifyListeners("stitchProgress", done)

                    val res = JSObject()
                    res.put("outputPath", outputPath)
                    res.put("width", outW)
                    res.put("height", outH)
                    res.put("isFullSphere", isFullSphere)
                    res.put("usedIndices", indices)
                    res.put("elapsedMs", System.currentTimeMillis() - startMs)
                    call.resolve(res)
                } else {
                    val statusCode = if (resultMeta.size >= 2) resultMeta[1] else -1
                    call.reject("OpenCV JNI stitch failed with status $statusCode")
                }
            } catch (t: Throwable) {
                call.reject("OpenCV JNI stitch error: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }
}
