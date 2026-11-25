#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface OpenCVStitcher : NSObject

+ (BOOL)isAvailable;
+ (NSString *)openCVVersion;

+ (BOOL)stitchImagesAtPaths:(NSArray<NSString *> *)paths
                 outputPath:(NSString *)outputPath
                targetWidth:(NSInteger)targetWidth
                jpegQuality:(NSInteger)jpegQuality
                  spherical:(BOOL)spherical
                usedIndices:(NSArray<NSNumber *> * _Nonnull * _Nonnull)usedIndices
                   outWidth:(NSInteger *)outWidth
                  outHeight:(NSInteger *)outHeight
               isFullSphere:(BOOL *)isFullSphere
                      error:(NSString * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END
