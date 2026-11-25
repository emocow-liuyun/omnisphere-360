cmake_minimum_required(VERSION 3.22.1)
project("omnisphere_stitcher")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Point OpenCV_DIR to the unpacked OpenCV Android SDK (e.g. third_party/opencv-android-sdk/sdk/native/jni)
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs features2d calib3d stitching)

add_library(
    omnisphere_stitcher
    SHARED
    stitcher_jni.cpp
)

target_include_directories(omnisphere_stitcher PRIVATE ${OpenCV_INCLUDE_DIRS})

target_link_libraries(
    omnisphere_stitcher
    ${OpenCV_LIBS}
    log
)
