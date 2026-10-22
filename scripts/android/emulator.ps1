# Demarre l'emulateur `guivault` (docs/ANDROID.md) s'il ne tourne pas, et
# attend la fin du demarrage d'Android.
. "$PSScriptRoot\env.ps1"
if (-not ((adb devices) -match "emulator-\d+\s+device")) {
  Start-Process "$env:ANDROID_HOME\emulator\emulator.exe" -ArgumentList "-avd", "guivault", "-no-snapshot-save", "-no-boot-anim" -WorkingDirectory "$env:USERPROFILE\android"
}
adb wait-for-device
for ($i = 0; $i -lt 150; $i++) {
  if ("$(adb shell getprop sys.boot_completed 2>$null)".Trim() -eq "1") { "emulateur pret"; exit 0 }
  Start-Sleep 2
}
"emulateur pas pret au bout de 5 min"; exit 1
