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

  # The build pipeline stages OpenCV into the host project as:
  #   ios/App/opencv/opencv2.framework   (binary, linked only)
  #   ios/App/opencv/include/opencv2/... (plain headers, compiled against)
  # Headers are kept OUT of the .framework so Clang does not treat them as a
  # framework module lacking a module map (which is a hard error with -Werror).
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
end
