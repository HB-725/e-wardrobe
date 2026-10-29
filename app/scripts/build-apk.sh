#!/usr/bin/env bash
# Builds a release APK on a Linux build box without Android Studio.
# Usage: scripts/build-apk.sh   (from the app/ directory)
# Release signing: export EW_KEYSTORE, EW_KEYSTORE_PASSWORD and EW_KEY_ALIAS (or EW_SIGNING_ENV=path/to/signing.env).
# Without them the APK is signed with the debug key (testing only; it cannot update a release-signed install).
# ARCHS overrides the CPU architectures (default arm64-v8a; add armeabi-v7a for old 32-bit phones).
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_HOME="$SDK"

# 1. Android SDK (accepting the SDK licenses is required to build).
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$SDK/cmdline-tools"
  curl -sSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
  unzip -q /tmp/cmdtools.zip -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
fi
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || true
"$SDK/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" >/dev/null

# 2. JDK 17 toolchain required by the React Native Gradle plugin.
JDK17=$(ls -d /usr/lib/jvm/java-17-openjdk-* 2>/dev/null | head -1 || true)
if [ -z "$JDK17" ]; then apt-get install -y -q openjdk-17-jdk-headless >/dev/null; JDK17=$(ls -d /usr/lib/jvm/java-17-openjdk-* | head -1); fi
mkdir -p ~/.gradle/init.d
grep -q java.installations.paths ~/.gradle/gradle.properties 2>/dev/null || cat >> ~/.gradle/gradle.properties <<PROPS
org.gradle.java.installations.paths=$JDK17
org.gradle.java.installations.auto-download=false
org.gradle.internal.repository.max.retries=8
org.gradle.internal.repository.initial.backoff=3000
PROPS

# 3. Maven Central rate-limits shared cloud IPs (HTTP 429 aborts resolution); use Google's mirror of Central.
cat > ~/.gradle/init.d/mirror.gradle <<'GRADLE'
def MIRROR = 'https://maven-central.storage-download.googleapis.com/maven2/'
def fix = { RepositoryHandler repos ->
  repos.configureEach { r ->
    if (r instanceof MavenArtifactRepository && r.url.toString() =~ /repo1?\.maven(\.apache)?\.org/) r.url = MIRROR
  }
  if (!repos.findByName('centralMirror')) {
    def m = repos.maven { name = 'centralMirror'; url = MIRROR }
    repos.remove(m); repos.addFirst(m)
  }
}
beforeSettings { settings ->
  def pm = settings.pluginManagement.repositories
  fix(pm)
  pm.gradlePluginPortal()
  pm.google()
  fix(settings.dependencyResolutionManagement.repositories)
}
allprojects {
  fix(buildscript.repositories)
  fix(repositories)
}
GRADLE

# 4. Generate the native project and build.
if [ -n "${EW_SIGNING_ENV:-}" ]; then set -a; . "$EW_SIGNING_ENV"; set +a; fi
if [ -n "${EW_KEYSTORE:-}" ]; then export EW_KEYSTORE="$(realpath "$EW_KEYSTORE")"; echo "Signing with $EW_KEYSTORE"; else echo "WARNING: no EW_KEYSTORE, signing with the debug key"; fi
EXPO_OFFLINE=1 CI=1 npx expo prebuild --platform android --no-install --clean
echo "sdk.dir=$SDK" > android/local.properties
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="${ARCHS:-arm64-v8a}" --no-daemon --console=plain)
ls -la android/app/build/outputs/apk/release/
