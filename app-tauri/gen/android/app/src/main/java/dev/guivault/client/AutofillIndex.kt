package dev.guivault.client

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/** Un identifiant que le remplissage peut proposer. */
data class FillEntry(
    val id: String,
    val name: String,
    val vault: String,
    val username: String,
    val password: String,
    /** Adresses avec leur règle (`domain`, `host`…) ; `androidapp://<paquet>` pour une application. */
    val uris: List<Pair<String, String?>>,
)

/** Qui demande : une application (paquet), ou un site dans un navigateur de
 * confiance (`domain`). */
data class Asker(val pkg: String, val domain: String?)

/**
 * L'index du remplissage automatique (`docs/REMPLISSAGE.md`) : les
 * identifiants que l'interface confie quand un coffre est ouvert.
 *
 * - **En mémoire** tant que l'application est déverrouillée (`update`) :
 *   remplir est immédiat ; `clear` au verrouillage.
 * - **Sur le disque, chiffré** : une clé AES au hasard chiffre l'index, et
 *   une clé RSA du Keystore l'enveloppe. Chiffrer n'a besoin que de la clé
 *   publique (aucune empreinte) ; déchiffrer exige une authentification
 *   biométrique forte, à chaque usage, et la clé meurt si les empreintes
 *   changent. Ainsi l'application fermée ou verrouillée remplit encore,
 *   après une empreinte — sauf après un redémarrage du téléphone ou au bout
 *   de 14 jours sans le mot de passe maître (comme `BiometricPlugin`).
 * - `forget` (déconnexion, coffre fermé, remplissage coupé) efface tout.
 */
object AutofillIndex {
    private const val KEY = "guivault.autofill"
    private const val FILE = "autofill.bin"
    private const val PREFS = "guivault_autofill"
    private const val MAX_AGE_MS = 14L * 24 * 3600 * 1000
    /** Après une empreinte, l'index reste ouvert le temps d'un second champ. */
    private const val KEEP_MS = 2L * 60 * 1000
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)

    @Volatile
    private var entries: List<FillEntry>? = null
    /** 0 : ouvert par l'application (jusqu'à `clear`) ; sinon l'échéance. */
    @Volatile
    private var expires = 0L
    @Volatile
    var label: String = ""
        private set

    /** L'index en clair, s'il est ouvert. */
    fun open(): List<FillEntry>? {
        val e = entries ?: return null
        if (expires != 0L && System.currentTimeMillis() > expires) {
            entries = null
            return null
        }
        return e
    }

    // ─── Ce que l'interface dit ─────────────────────────────────────────────

    /** Le coffre ouvert dans l'application : son index, en mémoire et, si la
     * biométrie le permet, chiffré sur le disque. */
    fun update(context: Context, json: String) {
        val (lbl, list) = parse(json) ?: return
        entries = list
        expires = 0L
        label = lbl
        persist(context, json)
    }

    /** L'application se verrouille : plus rien en clair. Le fichier reste. */
    fun clear() {
        entries = null
        expires = 0L
    }

    /** Déconnexion, coffre fermé, remplissage coupé : tout s'efface. */
    fun forget(context: Context) {
        clear()
        File(context.filesDir, FILE).delete()
        runCatching { keyStore().deleteEntry(KEY) }
    }

    /** Le mot de passe maître vient d'ouvrir un coffre : le délai repart. */
    fun passwordUsed(context: Context) {
        prefs(context).edit().putInt("pwd_boot", bootCount(context)).putLong("pwd_at", System.currentTimeMillis()).apply()
    }

    // ─── Le fichier chiffré ─────────────────────────────────────────────────

    enum class Stored { NONE, PASSWORD, READY }

    /** Ce que le disque permet sans l'application : rien, le mot de passe
     * d'abord (redémarrage, 14 jours), ou une empreinte. */
    fun stored(context: Context): Stored {
        if (!File(context.filesDir, FILE).exists()) return Stored.NONE
        val p = prefs(context)
        val fresh = p.getInt("pwd_boot", -2) == bootCount(context) && System.currentTimeMillis() - p.getLong("pwd_at", 0) < MAX_AGE_MS
        return if (fresh) Stored.READY else Stored.PASSWORD
    }

    private fun persist(context: Context, json: String) {
        val file = File(context.filesDir, FILE)
        try {
            val pub = publicKey() ?: run {
                file.delete()
                return
            }
            val aes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val ct = Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.ENCRYPT_MODE, SecretKeySpec(aes, "AES"), GCMParameterSpec(128, iv))
                doFinal(json.toByteArray(Charsets.UTF_8))
            }
            val wrapped = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").run {
                init(Cipher.ENCRYPT_MODE, pub, OAEP)
                doFinal(aes)
            }
            aes.fill(0)
            val out = JSONObject()
                .put("v", 1)
                .put("w", b64(wrapped))
                .put("iv", b64(iv))
                .put("ct", b64(ct))
            val tmp = File(context.filesDir, "$FILE.tmp")
            tmp.writeText(out.toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            // Pas de biométrie forte, Keystore indisponible : la mémoire seule.
            file.delete()
        }
    }

    /** Le chiffrement à présenter à l'invite biométrique ; `null` si la clé
     * n'est plus (empreintes changées : l'index est alors oublié). */
    fun unlockCipher(context: Context): Cipher? {
        val key = keyStore().getKey(KEY, null) as? PrivateKey ?: run {
            forget(context)
            return null
        }
        return try {
            Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply { init(Cipher.DECRYPT_MODE, key, OAEP) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            forget(context)
            null
        }
    }

    /** Après l'empreinte : rouvre l'index du disque, pour [KEEP_MS]. */
    fun openStored(context: Context, cipher: Cipher): List<FillEntry>? {
        val o = JSONObject(File(context.filesDir, FILE).readText())
        val aes = cipher.doFinal(unb64(o.getString("w")))
        val json = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(aes, "AES"), GCMParameterSpec(128, unb64(o.getString("iv"))))
            doFinal(unb64(o.getString("ct")))
        }
        aes.fill(0)
        val (lbl, list) = parse(String(json, Charsets.UTF_8)) ?: return null
        json.fill(0)
        entries = list
        label = lbl
        expires = System.currentTimeMillis() + KEEP_MS
        return list
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** La clé publique (hors du Keystore : chiffrer sans authentification),
     * créée au besoin ; `null` sans biométrie forte. */
    private fun publicKey(): java.security.PublicKey? {
        val ks = keyStore()
        if (!ks.containsAlias(KEY)) {
            val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_DECRYPT or KeyProperties.PURPOSE_ENCRYPT)
                .setKeySize(2048)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                }
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").run {
                initialize(spec)
                generateKeyPair()
            }
        }
        val pub = ks.getCertificate(KEY)?.publicKey ?: return null
        return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pub.encoded))
    }

    // ─── Qui reçoit quoi ────────────────────────────────────────────────────

    /** Les identifiants à proposer d'emblée : ceux dont une adresse
     * correspond au site, ou qui nomment l'application (`androidapp://`), ou
     * qu'on lui a associés (paquet **et** certificat de signature). */
    fun matches(context: Context, list: List<FillEntry>, asker: Asker): List<FillEntry> {
        val domain = asker.domain
        if (domain != null) {
            val host = hostOf(domain) ?: return emptyList()
            return list.filter { e -> e.uris.any { (u, m) -> uriMatches(u, m, host) } }
        }
        val app = "androidapp://${asker.pkg}"
        val linked = associated(context, asker.pkg)
        return list.filter { e -> e.id in linked || e.uris.any { (u, _) -> u.equals(app, ignoreCase = true) } }
    }

    /** Ce que l'on pourrait suggérer à une application qui n'a rien
     * d'associé, dans la liste seulement (jamais rempli d'office) : le nom
     * du paquet qui ressemble à un site (`com.github.android` → github). */
    fun guesses(list: List<FillEntry>, pkg: String): List<FillEntry> {
        val words = pkg.lowercase().split('.').filter { it.length >= 4 && it !in setOf("android", "mobile", "client", "app", "apps") }
        if (words.isEmpty()) return emptyList()
        return list.filter { e ->
            e.uris.any { (u, _) -> val h = hostOf(u) ?: return@any false; words.any { w -> baseDomain(h).startsWith("$w.") } } ||
                words.any { w -> e.name.lowercase().contains(w) }
        }
    }

    private fun uriMatches(uri: String, mode: String?, host: String): Boolean {
        if (mode == "never" || uri.startsWith("androidapp://")) return false
        val h = hostOf(uri) ?: return false
        return when (mode) {
            "host", "exact", "startsWith", "regex" -> h == host
            else -> baseDomain(h) == baseDomain(host)
        }
    }

    fun hostOf(value: String): String? {
        val v = value.trim()
        if (v.isEmpty()) return null
        val withScheme = if (v.contains("://")) v else "https://$v"
        return Uri.parse(withScheme).host?.lowercase()?.removePrefix("www.")?.takeIf { it.isNotEmpty() }
    }

    /** Le domaine enregistrable, à peu près (`a.b.exemple.fr` → `exemple.fr`,
     * `x.exemple.co.uk` → `exemple.co.uk`). */
    fun baseDomain(host: String): String {
        if (host.all { it.isDigit() || it == '.' } || !host.contains('.')) return host
        val labels = host.split('.')
        val n = labels.size
        if (n <= 2) return host
        val second = labels[n - 2]
        val keep = if (labels[n - 1].length == 2 && second in setOf("co", "com", "org", "net", "gov", "gouv", "ac", "edu", "asso", "ne", "or")) 3 else 2
        return labels.takeLast(keep).joinToString(".")
    }

    // ─── Associations application → identifiant ─────────────────────────────

    /** Retenir que cette application reçoit cet identifiant — liée à son
     * certificat de signature : une autre application du même nom ne
     * l'aura pas. */
    fun associate(context: Context, pkg: String, entryId: String) {
        val cert = certificate(context, pkg) ?: return
        val p = prefs(context)
        val all = JSONObject(p.getString("links", "{}") ?: "{}")
        val key = "$pkg|$cert"
        val ids = all.optJSONArray(key) ?: JSONArray()
        if ((0 until ids.length()).none { ids.getString(it) == entryId }) ids.put(entryId)
        all.put(key, ids)
        p.edit().putString("links", all.toString()).apply()
    }

    private fun associated(context: Context, pkg: String): Set<String> {
        val cert = certificate(context, pkg) ?: return emptySet()
        val all = JSONObject(prefs(context).getString("links", "{}") ?: "{}")
        val ids = all.optJSONArray("$pkg|$cert") ?: return emptySet()
        return (0 until ids.length()).map { ids.getString(it) }.toSet()
    }

    /** L'empreinte SHA-256 du certificat qui signe `pkg`. */
    fun certificate(context: Context, pkg: String): String? = try {
        val pm = context.packageManager
        val bytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo ?: return null
            val signers = if (info.hasMultipleSigners()) info.apkContentsSigners else info.signingCertificateHistory
            signers?.firstOrNull()?.toByteArray()
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()?.toByteArray()
        } ?: return null
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    } catch (e: Exception) {
        null
    }

    /** Le nom affiché d'une application. */
    fun appLabel(context: Context, pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        pkg
    }

    // ─── Petits outils ──────────────────────────────────────────────────────

    private fun parse(json: String): Pair<String, List<FillEntry>>? = try {
        val o = JSONObject(json)
        val arr = o.getJSONArray("entries")
        val list = (0 until arr.length()).map { i ->
            val e = arr.getJSONObject(i)
            val uris = e.optJSONArray("uris") ?: JSONArray()
            FillEntry(
                id = e.getString("id"),
                name = e.optString("name"),
                vault = e.optString("vault"),
                username = e.optString("username"),
                password = e.optString("password"),
                uris = (0 until uris.length()).map { j ->
                    val u = uris.getJSONObject(j)
                    u.getString("uri") to (if (u.isNull("match")) null else u.optString("match"))
                },
            )
        }
        o.optString("label") to list
    } catch (e: Exception) {
        null
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun bootCount(context: Context): Int = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)
}
