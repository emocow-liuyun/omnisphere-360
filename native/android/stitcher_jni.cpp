#include <jni.h>
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>
#include <opencv2/opencv.hpp>
#include <opencv2/stitching.hpp>
#include <opencv2/stitching/warpers.hpp>

namespace {
struct JniUtfString {
    JNIEnv* env;
    jstring jstr;
    const char* chars;
    JniUtfString(JNIEnv* e, jstring s) : env(e), jstr(s), chars(nullptr) {
        if (s != nullptr) {
            chars = env->GetStringUTFChars(s, nullptr);
        }
    }
    ~JniUtfString() {
        if (jstr != nullptr && chars != nullptr) {
            env->ReleaseStringUTFChars(jstr, chars);
        }
    }
    JniUtfString(const JniUtfString&) = delete;
    JniUtfString& operator=(const JniUtfString&) = delete;
};
} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_omnisphere_camera360_OmniStitcherPlugin_nativeGetOpenCVVersion(
    JNIEnv* env,
    jobject /* this */
) {
    return env->NewStringUTF(CV_VERSION);
}

extern "C" JNIEXPORT jintArray JNICALL
Java_com_omnisphere_camera360_OmniStitcherPlugin_nativeStitchPanorama(
    JNIEnv* env,
    jobject /* this */,
    jobjectArray inputPaths,
    jstring outputPath,
    jint targetWidth,
    jint jpegQuality,
    jboolean spherical
) {
    auto makeError = [&](jint code) -> jintArray {
        if (env->ExceptionCheck()) {
            return nullptr;
        }
        jintArray arr = env->NewIntArray(5);
        if (arr == nullptr || env->ExceptionCheck()) {
            return nullptr;
        }
        jint meta[5] = {0, code, 0, 0, 0};
        env->SetIntArrayRegion(arr, 0, 5, meta);
        return arr;
    };

    if (inputPaths == nullptr || outputPath == nullptr) {
        return makeError(-10);
    }

    try {
        jsize count = env->GetArrayLength(inputPaths);
        if (count > 64) {
            return makeError(-13);
        }
        std::vector<cv::Mat> images;
        std::vector<int> validOriginalIndices;
        images.reserve(count);

        const int maxInputDim = count > 24 ? 1280 : 1600;
        const int readFlag = count > 24 ? cv::IMREAD_REDUCED_COLOR_2 : cv::IMREAD_COLOR;
        for (jsize i = 0; i < count; ++i) {
            auto jPath = static_cast<jstring>(env->GetObjectArrayElement(inputPaths, i));
            if (env->ExceptionCheck()) {
                return makeError(-11);
            }
            if (jPath == nullptr) continue;

            {
                JniUtfString pathGuard(env, jPath);
                if (env->ExceptionCheck() || pathGuard.chars == nullptr) {
                    env->DeleteLocalRef(jPath);
                    return makeError(-14);
                }
                cv::Mat img = cv::imread(pathGuard.chars, readFlag);
                if (!img.empty()) {
                    int maxDim = std::max(img.cols, img.rows);
                    if (maxDim > maxInputDim) {
                        double scale = static_cast<double>(maxInputDim) / maxDim;
                        cv::resize(img, img, cv::Size(), scale, scale, cv::INTER_AREA);
                    }
                    images.push_back(std::move(img));
                    validOriginalIndices.push_back(static_cast<int>(i));
                }
            }
            env->DeleteLocalRef(jPath);
        }

        if (images.size() < 2) {
            return makeError(-2);
        }

        cv::Ptr<cv::Stitcher> stitcher = cv::Stitcher::create(cv::Stitcher::PANORAMA);
        stitcher->setFeaturesFinder(cv::ORB::create(2000));
        stitcher->setPanoConfidenceThresh(0.45);
        stitcher->setRegistrationResol(0.6);
        stitcher->setSeamEstimationResol(0.15);
        stitcher->setCompositingResol(cv::Stitcher::ORIG_RESOL);
        stitcher->setWaveCorrection(true);
        if (spherical) {
            stitcher->setWarper(cv::makePtr<cv::SphericalWarper>());
        } else {
            stitcher->setWarper(cv::makePtr<cv::CylindricalWarper>());
        }
        stitcher->setExposureCompensator(cv::makePtr<cv::detail::BlocksGainCompensator>());
        stitcher->setSeamFinder(cv::makePtr<cv::detail::GraphCutSeamFinder>(
            cv::detail::GraphCutSeamFinderBase::COST_COLOR_GRAD
        ));
        stitcher->setBlender(cv::makePtr<cv::detail::MultiBandBlender>(false, 5));

        cv::Mat pano;
        cv::Stitcher::Status status = stitcher->stitch(images, pano);
        if (status != cv::Stitcher::OK || pano.empty()) {
            stitcher->setPanoConfidenceThresh(0.3);
            status = stitcher->stitch(images, pano);
        }
        if (status != cv::Stitcher::OK || pano.empty()) {
            return makeError(static_cast<jint>(status));
        }

        double aspect = static_cast<double>(pano.cols) / std::max(1, pano.rows);
        bool isFullSphere = spherical && (aspect >= 1.85 && aspect <= 2.15);

        if (targetWidth > 0 && pano.cols > targetWidth) {
            int targetHeight = std::max(
                1,
                static_cast<int>(std::llround(static_cast<double>(pano.rows) * targetWidth / pano.cols))
            );
            cv::resize(pano, pano, cv::Size(targetWidth, targetHeight), 0, 0, cv::INTER_AREA);
        }

        bool ok = false;
        {
            JniUtfString outGuard(env, outputPath);
            if (outGuard.chars != nullptr) {
                std::vector<int> params = { cv::IMWRITE_JPEG_QUALITY, static_cast<int>(jpegQuality) };
                ok = cv::imwrite(outGuard.chars, pano, params);
            }
        }

        if (!ok) {
            return makeError(-3);
        }

        std::vector<int> usedIndices;
        std::vector<int> comp = stitcher->component();
        if (!comp.empty()) {
            for (int idx : comp) {
                if (idx >= 0 && idx < static_cast<int>(validOriginalIndices.size())) {
                    usedIndices.push_back(validOriginalIndices[idx]);
                }
            }
        } else {
            usedIndices = validOriginalIndices;
        }

        std::vector<jint> payload;
        payload.reserve(5 + usedIndices.size());
        payload.push_back(1);
        payload.push_back(static_cast<jint>(usedIndices.size()));
        payload.push_back(pano.cols);
        payload.push_back(pano.rows);
        payload.push_back(isFullSphere ? 1 : 0);
        for (int idx : usedIndices) {
            payload.push_back(static_cast<jint>(idx));
        }

        jintArray result = env->NewIntArray(static_cast<jsize>(payload.size()));
        if (result == nullptr) {
            return makeError(-12);
        }
        env->SetIntArrayRegion(result, 0, static_cast<jsize>(payload.size()), payload.data());
        return result;
    } catch (const cv::Exception&) {
        return makeError(-20);
    } catch (...) {
        return makeError(-21);
    }
}
