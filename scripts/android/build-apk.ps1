# Construit l'APK de GuiVault (docs/ANDROID.md) dans la copie Windows du depot
# (scripts/android-sync.sh), l'interface deja construite dans web/dist-app.
#   .\build-apk.ps1                    # debug, x86_64 (l'emulateur)
#   .\build-apk.ps1 -Target aarch64    # un vrai telephone (plusieurs : -Target aarch64,x86_64)
#   .\build-apk.ps1 -Release
param([string[]]$Target = @("x86_64"), [switch]$Release)
. "$PSScriptRoot\env.ps1"
Set-Location "$PSScriptRoot\..\..\app-tauri"
# Pas de beforeBuildCommand : npm reste cote WSL.
$config = '{"build":{"beforeBuildCommand":"","beforeDevCommand":""}}'
$configFile = Join-Path $env:TEMP "guivault-android-build.json"
Set-Content -Path $configFile -Value $config -Encoding ascii
$cmd = @("tauri", "android", "build", "--apk", "--config", $configFile)
foreach ($t in $Target) { $cmd += @("--target", $t) }
if (-not $Release) { $cmd += "--debug" }
# Le journal dans un fichier : le demon de Gradle herite de la sortie et la
# garderait ouverte (WSL ne verrait jamais la fin).
$log = "$env:USERPROFILE\android\build-apk.log"
& cargo @cmd *> $log
$code = $LASTEXITCODE
& "gen\android\gradlew.bat" --project-dir "gen\android" --stop *> $null
"EXIT $code (journal : $log)"
Get-ChildItem -Recurse "gen\android\app\build\outputs\apk" -Filter *.apk -ErrorAction SilentlyContinue | ForEach-Object { "APK $($_.FullName) $($_.Length)" }
