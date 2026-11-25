require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorOmnisphereStitcher'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.homepage = 'https://github.com/omnisphere/camera360'
  s.author = 'OmniSphere'

  s.source = { :git => 'https://github.com/omnisphere/camera360.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m,mm,cpp}'
  s.ios.deployment_target = '15.0'

  # OpenCV is a static framework; keep the pod static so nothing needs embedding.
  s.static_framework = true

  s.dependency 'Capacitor'
  s.frameworks = 'AVFoundation', 'CoreMotion', 'Accelerate', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'UIKit'
  s.libraries = 'c++', 'z'

  s.swift_version = '5.1'

  # OpenCV is optional at link time: "OPENCV_IOS_ENABLED=1" makes the pod link the
  # staged opencv2.framework; otherwise OpenCVStitcher.mm compiles with
  # HAS_OPENCV_STITCHING undefined, the plugin reports unavailable, and the app
  # falls back to the on-device CPU/Canvas stitcher.
  if ENV['OPENCV_IOS_ENABLED'] == '1'
    opencv_fw = '"${PODS_ROOT}/../opencv"'
    opencv_inc = '"${PODS_ROOT}/../opencv/include"'

    s.pod_target_xcconfig = {
      'FRAMEWORK_SEARCH_PATHS' => "#{opencv_fw} $(inherited)",
      'HEADER_SEARCH_PATHS' => "#{opencv_inc} $(inherited)",
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'CLANG_CXX_LIBRARY' => 'libc++',
      'ENABLE_BITCODE' => 'NO',
      'GCC_ENABLE_CPP_EXCEPTIONS' => 'YES',
      'GCC_ENABLE_CPP_RTTI' => 'YES'
    }

    s.user_target_xcconfig = {
      'FRAMEWORK_SEARCH_PATHS' => "#{opencv_fw} $(inherited)",
      'OTHER_LDFLAGS' => '-framework opencv2 $(inherited)'
    }
  else
    s.pod_target_xcconfig = {
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'CLANG_CXX_LIBRARY' => 'libc++',
      'ENABLE_BITCODE' => 'NO',
      'GCC_ENABLE_CPP_EXCEPTIONS' => 'YES',
      'GCC_ENABLE_CPP_RTTI' => 'YES'
    }
  end
end
