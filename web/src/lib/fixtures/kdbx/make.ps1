# Bases KeePass de test pour web/src/lib/kdbx.test.ts, écrites par KeePass
# lui-même (KeePassLib, KeePass 2.61). Mot de passe : guivault-kdbx-test.
# Enregistré en UTF-8 **avec BOM** : sans, PowerShell 5.1 le lit en
# Windows-1252 et les accents entrent doublement encodés dans les bases.
param([string]$Out)
$ErrorActionPreference = "Stop"
[void][Reflection.Assembly]::LoadFrom("C:\Program Files\KeePass Password Safe 2\KeePass.exe")
function New-PStr([bool]$protect, [string]$v) { New-Object KeePassLib.Security.ProtectedString($protect, $v) }
function Entry($title, $user, $pass, $url, $notes) {
  $e = New-Object KeePassLib.PwEntry($true, $true)
  $e.Strings.Set("Title", (New-PStr $false $title))
  $e.Strings.Set("UserName", (New-PStr $false $user))
  $e.Strings.Set("Password", (New-PStr $true $pass))
  $e.Strings.Set("URL", (New-PStr $false $url))
  $e.Strings.Set("Notes", (New-PStr $false $notes))
  return $e
}
function Make($file, $kdf, $cipher, $keyFile, [switch]$Kdbx31) {
  $path = Join-Path $Out $file
  if (Test-Path $path) { Remove-Item $path }
  $db = New-Object KeePassLib.PwDatabase
  $key = New-Object KeePassLib.Keys.CompositeKey
  $key.AddUserKey((New-Object KeePassLib.Keys.KcpPassword("guivault-kdbx-test")))
  if ($keyFile) { $key.AddUserKey((New-Object KeePassLib.Keys.KcpKeyFile($keyFile))) }
  $db.New([KeePassLib.Serialization.IOConnectionInfo]::FromPath($path), $key)
  $db.Name = "Base de test"
  $db.KdfParameters = $kdf
  if ($cipher) { $db.DataCipherUuid = $cipher }
  $root = $db.RootGroup
  # KeePass crée des groupes d'exemple avec une nouvelle base : on repart de zéro.
  foreach ($g in @($root.Groups)) { $root.Groups.Remove($g) | Out-Null }
  foreach ($e in @($root.Entries)) { $root.Entries.Remove($e) | Out-Null }

  $internet = New-Object KeePassLib.PwGroup($true, $true, "Internet", [KeePassLib.PwIcon]::World)
  $root.AddGroup($internet, $true)
  $gh = Entry "GitHub" "alice" "gh-pass-1" "https://github.com/login" "notes github"
  $gh.CreateBackup($db)
  $gh.Strings.Set("Password", (New-PStr $true "gh-pass-2"))
  $gh.Strings.Set("PIN", (New-PStr $true "4321"))
  $gh.Strings.Set("Remarque", (New-PStr $false "visible"))
  $gh.Strings.Set("TimeOtp-Secret-Base32", (New-PStr $true "JBSWY3DPEHPK3PXP"))
  $gh.Tags.Add("dev"); $gh.Tags.Add("perso")
  $gh.AutoType.DefaultSequence = "{USERNAME}{TAB}{PASSWORD}{TAB}{TOTP}{ENTER}"
  $gh.AutoType.Add((New-Object KeePassLib.Collections.AutoTypeAssociation("*GitHub*Firefox*", "{PASSWORD}{ENTER}")))
  $gh.Binaries.Set("cle.txt", (New-Object KeePassLib.Security.ProtectedBinary($false, [Text.Encoding]::UTF8.GetBytes("contenu de la pièce jointe"))))
  $internet.AddEntry($gh, $true)

  $banques = New-Object KeePassLib.PwGroup($true, $true, "Banques", [KeePassLib.PwIcon]::Money)
  $internet.AddGroup($banques, $true)
  $bank = Entry "Banque" "bob" "b@nk" "banque.example" ""
  $bank.Expires = $true
  $bank.ExpiryTime = New-Object DateTime(2030, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
  $bank.AutoType.Enabled = $false
  $banques.AddEntry($bank, $true)

  $srv = Entry "Serveur" "root" "srv-pass" "" ""
  $srv.Strings.Set("otp", (New-PStr $true "otpauth://totp/Serveur?secret=GEZDGNBVGY3TQOJQ&period=30&digits=6"))
  $root.AddEntry($srv, $true)

  $wifi = Entry "Wi-Fi maison" "" "" "" "SSID : maison`nClé : xyz"
  $root.AddEntry($wifi, $true)

  $bin = New-Object KeePassLib.PwGroup($true, $true, "Corbeille", [KeePassLib.PwIcon]::TrashBin)
  $root.AddGroup($bin, $true)
  $db.RecycleBinEnabled = $true
  $db.RecycleBinUuid = $bin.Uuid
  $bin.AddEntry((Entry "Supprimé" "x" "y" "" ""), $true)

  if ($Kdbx31) {
    # KeePass 2.61 écrit du KDBX 4 même quand le 3.1 suffirait : on force le
    # 3.1 (le format de beaucoup de bases anciennes) par le champ privé
    # `m_uForceVersion` de KdbxFile.
    $kdbx = New-Object KeePassLib.Serialization.KdbxFile($db)
    $t = [KeePassLib.Serialization.KdbxFile]
    $flags = [Reflection.BindingFlags]"Instance,NonPublic"
    $v31 = $t.GetField("FileVersion32_3_1", [Reflection.BindingFlags]"Static,NonPublic,Public").GetValue($null)
    $t.GetField("m_uForceVersion", $flags).SetValue($kdbx, $v31)
    $fs = [IO.File]::Create($path)
    try { $kdbx.Save($fs, $null, [KeePassLib.Serialization.KdbxFormat]::Default, $null) } finally { $fs.Dispose() }
  } else {
    $db.Save($null)
  }
  $db.Close()
  "$file : $((Get-Item $path).Length) octets"
}
$argon2d = (New-Object KeePassLib.Cryptography.KeyDerivation.Argon2Kdf([KeePassLib.Cryptography.KeyDerivation.Argon2Type]::D)).GetDefaultParameters()
$argon2d.SetUInt64("I", 2); $argon2d.SetUInt64("M", 1048576); $argon2d.SetUInt32("P", 1)
Make "keepass-argon2d.kdbx" $argon2d $null $null

$argon2id = (New-Object KeePassLib.Cryptography.KeyDerivation.Argon2Kdf([KeePassLib.Cryptography.KeyDerivation.Argon2Type]::ID)).GetDefaultParameters()
$argon2id.SetUInt64("I", 2); $argon2id.SetUInt64("M", 1048576); $argon2id.SetUInt32("P", 2)
Make "keepass-argon2id-chacha20.kdbx" $argon2id ([KeePassLib.Cryptography.Cipher.ChaCha20Engine]::ChaCha20Uuid) $null

$keyFile = Join-Path $Out "keepass.keyx"
if (Test-Path $keyFile) { Remove-Item $keyFile }
[KeePassLib.Keys.KcpKeyFile]::Create($keyFile, $null)
$aes = (New-Object KeePassLib.Cryptography.KeyDerivation.AesKdf).GetDefaultParameters()
$aes.SetUInt64("R", 1000)
Make "keepass-kdbx31-aeskdf-keyfile.kdbx" $aes $null $keyFile -Kdbx31
