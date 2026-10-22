# Installe et lance l'APK debug sur l'emulateur ou le telephone branche.
param([string]$Abi = "x86_64")
. "$PSScriptRoot\env.ps1"
$apk = Get-ChildItem -Recurse "$PSScriptRoot\..\..\app-tauri\gen\android\app\build\outputs\apk" -Filter "*$Abi*debug*.apk" | Select-Object -First 1
if (-not $apk) { $apk = Get-ChildItem -Recurse "$PSScriptRoot\..\..\app-tauri\gen\android\app\build\outputs\apk" -Filter *.apk | Select-Object -First 1 }
"APK $($apk.FullName)"
adb install -r $apk.FullName
adb shell monkey -p dev.guivault.client -c android.intent.category.LAUNCHER 1 | Out-Null
