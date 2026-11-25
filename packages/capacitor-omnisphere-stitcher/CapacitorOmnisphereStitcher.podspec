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
  s.ios.deployment_target = '14.0'

  # OpenCV 4.x iOS framework is a static framework; force static linkage for the pod.
  s.static_framework = true

  s.dependency 'Capacitor'
  s.frameworks = 'AVFoundation', 'CoreMotion', 'Accelerate', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'UIKit'
  s.libraries = 'c++', 'z'

  s.swift_version = '5.1'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'ENABLE_BITCODE' => 'NO',
    'GCC_ENABLE_CPP_EXCEPTIONS' => 'YES',
    'GCC_ENABLE_CPP_RTTI' => 'YES'
  }

  xcframework_path = File.join(__dir__, 'ios', 'Frameworks', 'opencv2.xcframework')
  framework_path = File.join(__dir__, 'ios', 'Frameworks', 'opencv2.framework')

  if File.exist?(xcframework_path)
    s.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'
  elsif File.exist?(framework_path)
    s.vendored_frameworks = 'ios/Frameworks/opencv2.framework'
  else
    # Framework not staged locally; CI workflow downloads it before `pod install`.
    # A missing vendored framework simply leaves the native stitcher unavailable
    # and the app falls back to the on-device CPU/Canvas stitcher.
    Pod::UI.warn('[OmniSphere] opencv2.framework not found in ios/Frameworks — native OpenCV stitcher will report unavailable.')
  end
end
