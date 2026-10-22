# L'environnement Android du poste (docs/ANDROID.md) : JDK, SDK, NDK sous
# %USERPROFILE%\android, cargo de Windows. A inclure : . .\env.ps1
$root = "$env:USERPROFILE\android"
$env:JAVA_HOME = "$root\jdk-17"
$env:ANDROID_HOME = "$root\sdk"
$env:NDK_HOME = "$root\sdk\ndk\28.2.13676358"
# Sans elle, Java ne peut pas ouvrir son canal interne sous ce profil.
$env:JAVA_TOOL_OPTIONS = "-Djdk.net.unixdomain.tmpdir=$root\tmp"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$root\sdk\platform-tools;$env:PATH"
