#import "OpenCVStitcher.h"

// Apple's objc.h defines NO/YES as macros, but OpenCV stitching enums use the
// identifiers NO (e.g. Blender::NO, ExposureCompensator::NO). Undefine them only
// while pulling in OpenCV so the C++ enum names stay valid identifiers.
#pragma push_macro("NO")
#pragma push_macro("YES")
#undef NO
#undef YES

#ifdef __has_include
#if __has_include(<opencv2/stitching.hpp>)
#define HAS_OPENCV_STITCHING 1
#import <opencv2/opencv.hpp>
#import <opencv2/stitching.hpp>
#import <opencv2/stitching/warpers.hpp>
#endif
#endif

#pragma pop_macro("YES")
#pragma pop_macro("NO")

@implementation OpenCVStitcher

+ (BOOL)isAvailable {
#ifdef HAS_OPENCV_STITCHING
    return YES;
#else
    return NO;
#endif
}

+ (NSString *)openCVVersion {
#ifdef HAS_OPENCV_STITCHING
    return [NSString stringWithUTF8String:CV_VERSION];
#else
    return @"not-linked";
#endif
}

+ (BOOL)stitchImagesAtPaths:(NSArray<NSString *> *)paths
                 outputPath:(NSString *)outputPath
                targetWidth:(NSInteger)targetWidth
                jpegQuality:(NSInteger)jpegQuality
                  spherical:(BOOL)spherical
                usedIndices:(NSArray<NSNumber *> * _Nonnull * _Nonnull)usedIndices
                   outWidth:(NSInteger *)outWidth
                  outHeight:(NSInteger *)outHeight
               isFullSphere:(BOOL *)isFullSphere
                      error:(NSString * _Nullable * _Nullable)error {
#ifdef HAS_OPENCV_STITCHING
    try {
        if (paths.count > 64) {
            if (error) *error = @"Too many input frames (max 64)";
            return NO;
        }

        std::vector<cv::Mat> images;
        std::vector<NSInteger> validOriginalIndices;
        images.reserve(paths.count);

        // Adaptive input cap to bound mobile RAM peak before stitching
        const int maxInputDim = paths.count > 24 ? 1280 : 1600;
        for (NSUInteger i = 0; i < paths.count; ++i) {
            NSString *path = paths[i];
            cv::Mat img = cv::imread([path UTF8String], cv::IMREAD_COLOR);
            if (!img.empty()) {
                int maxDim = std::max(img.cols, img.rows);
                if (maxDim > maxInputDim) {
                    double scale = static_cast<double>(maxInputDim) / maxDim;
                    cv::resize(img, img, cv::Size(), scale, scale, cv::INTER_AREA);
                }
                images.push_back(img);
                validOriginalIndices.push_back((NSInteger)i);
            }
        }

        if (images.size() < 2) {
            if (error) *error = @"Need at least 2 valid images to stitch";
            return NO;
        }

        cv::Ptr<cv::Stitcher> stitcher = cv::Stitcher::create(cv::Stitcher::PANORAMA);
        if (spherical) {
            stitcher->setWarper(cv::makePtr<cv::SphericalWarper>());
        } else {
            stitcher->setWarper(cv::makePtr<cv::CylindricalWarper>());
        }
        stitcher->setExposureCompensator(cv::makePtr<cv::detail::BlocksGainCompensator>());
        stitcher->setBlender(cv::makePtr<cv::detail::MultiBandBlender>(false, 5));

        cv::Mat pano;
        cv::Stitcher::Status status = stitcher->stitch(images, pano);
        if (status != cv::Stitcher::OK || pano.empty()) {
            if (error) {
                *error = [NSString stringWithFormat:@"OpenCV Stitcher failed with status %d", (int)status];
            }
            return NO;
        }

        // Preserve true stitched aspect ratio; never stretch partial panoramas into 2:1
        double aspect = static_cast<double>(pano.cols) / std::max(1, pano.rows);
        BOOL fullSphere = spherical && (aspect >= 1.85 && aspect <= 2.15);

        if (targetWidth > 0 && pano.cols > targetWidth) {
            int targetHeight = std::max(1, (int)std::llround(static_cast<double>(pano.rows) * targetWidth / pano.cols));
            cv::resize(pano, pano, cv::Size((int)targetWidth, targetHeight), 0, 0, cv::INTER_AREA);
        }

        std::vector<int> params = { cv::IMWRITE_JPEG_QUALITY, (int)jpegQuality };
        BOOL written = cv::imwrite([outputPath UTF8String], pano, params);
        if (!written) {
            if (error) *error = @"Failed to write stitched JPEG";
            return NO;
        }

        NSMutableArray<NSNumber *> *outIndices = [NSMutableArray array];
        std::vector<int> comp = stitcher->component();
        if (!comp.empty()) {
            for (int idx : comp) {
                if (idx >= 0 && idx < (int)validOriginalIndices.size()) {
                    [outIndices addObject:@(validOriginalIndices[idx])];
                }
            }
        } else {
            for (NSInteger idx : validOriginalIndices) {
                [outIndices addObject:@(idx)];
            }
        }

        *usedIndices = outIndices;
        if (outWidth) *outWidth = pano.cols;
        if (outHeight) *outHeight = pano.rows;
        if (isFullSphere) *isFullSphere = fullSphere;
        return YES;
    } catch (const cv::Exception &e) {
        if (error) *error = [NSString stringWithUTF8String:e.what()];
        return NO;
    } catch (const std::exception &e) {
        if (error) *error = [NSString stringWithUTF8String:e.what()];
        return NO;
    }
#else
    if (error) *error = @"OpenCV2.xcframework is not linked in this Xcode target";
    return NO;
#endif
}

@end
