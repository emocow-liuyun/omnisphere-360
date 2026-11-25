package com.omnisphere.camera360

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
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

@CapacitorPlugin(name = "OmniStitcher")
class OmniStitcherPlugin : Plugin(), SensorEventListener {

    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null
    private var sensorThread: HandlerThread? = null
    private var sensorHandler: Handler? = null
    private val stitchExecutor = Executors.newSingleThreadExecutor()
    private val rotationMatrix = FloatArray(9)
    private val remappedMatrix = FloatArray(9)
    private val orientationAngles = FloatArray(3)
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
    fun lockExposureAndFocus(call: PluginCall) {
        // WebRTC getUserMedia does not expose Camera2 CaptureRequest lock directly;
        // report unsupported honestly unless a native CameraX session is bound.
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
        val sensor = mgr.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        if (sensor == null) {
            call.reject("TYPE_ROTATION_VECTOR sensor unavailable")
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
            call.reject("Failed to register TYPE_ROTATION_VECTOR listener")
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
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        // Throttle bridge events to <= 60Hz
        if (event.timestamp - lastEmitNs < 16_000_000L) return
        lastEmitNs = event.timestamp

        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        SensorManager.remapCoordinateSystem(
            rotationMatrix,
            SensorManager.AXIS_X,
            SensorManager.AXIS_Z,
            remappedMatrix
        )
        SensorManager.getOrientation(remappedMatrix, orientationAngles)

        val rad2deg = 180.0 / Math.PI
        var yawDeg = (orientationAngles[0] * rad2deg) % 360.0
        if (yawDeg < 0) yawDeg += 360.0
        val pitchDeg = (-orientationAngles[1] * rad2deg).coerceIn(-89.9, 89.9)
        val rollDeg = orientationAngles[2] * rad2deg

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

                // resultMeta layout: [ok(1/0), statusOrUsedCount, width, height, isFullSphere(1/0), ...usedIndices]
                if (resultMeta != null && resultMeta.size >= 5 && resultMeta[0] == 1) {
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
                    val statusCode = if (resultMeta != null && resultMeta.size >= 2) resultMeta[1] else -1
                    call.reject("OpenCV JNI stitch failed with status $statusCode")
                }
            } catch (t: Throwable) {
                call.reject("OpenCV JNI stitch error: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }
}
