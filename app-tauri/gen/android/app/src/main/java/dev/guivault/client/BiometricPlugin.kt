package dev.guivault.client

import android.app.Activity
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class BioIdArgs {
    lateinit var id: String
}

@InvokeArg
class BioEnableArgs {
    lateinit var id: String
    lateinit var secret: String
    var title: String = "Déverrouillage biométrique"
}

@InvokeArg
class BioUnlockArgs {
    lateinit var id: String
    var title: String = "Déverrouiller GuiVault"
    var subtitle: String? = null
}

/**
 * Le déverrouillage par empreinte ou visage (`docs/ANDROID.md`,
 * « Déverrouillage biométrique »). L'interface confie un secret (la user key
 * d'un coffre ou d'un compte, déjà en clair dans sa mémoire) ; il est
 * chiffré en AES-256-GCM sous une clé du Keystore Android qui ne sert
 * qu'après une authentification biométrique **forte** (classe 3), à chaque
 * usage, et que le système détruit si les empreintes changent. Rien ne sort
 * du téléphone ; le serveur n'en sait rien.
 *
 * Le mot de passe maître reste demandé après un redémarrage du téléphone et
 * au bout de [MAX_AGE_MS] sans lui : on le dit à l'interface (`password`)
 * sans même montrer l'invite.
 */
@TauriPlugin
class BiometricPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val KEY = "guivault.biometric"
        private const val PREFS = "guivault_biometric"
        private const val MAX_AGE_MS = 14L * 24 * 3600 * 1000
    }

    private val prefs get() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun bootCount(): Int = Settings.Global.getInt(activity.contentResolver, Settings.Global.BOOT_COUNT, -1)

    private fun entry(id: String): JSONObject? = prefs.getString("e:$id", null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    /** Ce que le téléphone permet : `ready`, `not-enrolled` (aucune empreinte
     * ni visage de classe 3), ou `unavailable`. */
    @Command
    fun status(invoke: Invoke) {
        val state = when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> "ready"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "not-enrolled"
            else -> "unavailable"
        }
        invoke.resolve(JSObject().put("value", state))
    }

    /** Activé pour ce coffre ? Et sinon le mot de passe, pourquoi (`reboot`,
     * `age`) ? */
    @Command
    fun state(invoke: Invoke) {
        val args = invoke.parseArgs(BioIdArgs::class.java)
        val e = entry(args.id)
        val out = JSObject().put("enabled", e != null)
        if (e != null) passwordReason(e)?.let { out.put("password", it) }
        invoke.resolve(out)
    }

    private fun passwordReason(e: JSONObject): String? = when {
        e.optInt("boot", -1) != bootCount() -> "reboot"
        System.currentTimeMillis() - e.optLong("at", 0) > MAX_AGE_MS -> "age"
        else -> null
    }

    /** Le mot de passe maître vient d'ouvrir ce coffre : le délai repart. */
    @Command
    fun touch(invoke: Invoke) {
        val args = invoke.parseArgs(BioIdArgs::class.java)
        entry(args.id)?.let { e ->
            e.put("boot", bootCount()).put("at", System.currentTimeMillis())
            prefs.edit().putString("e:${args.id}", e.toString()).apply()
        }
        invoke.resolve()
    }

    @Command
    fun disable(invoke: Invoke) {
        val args = invoke.parseArgs(BioIdArgs::class.java)
        prefs.edit().remove("e:${args.id}").apply()
        if (prefs.all.keys.none { it.startsWith("e:") }) runCatching { keyStore().deleteEntry(KEY) }
        invoke.resolve()
    }

    /** Chiffre `secret` sous la clé du Keystore, après une empreinte. */
    @Command
    fun enable(invoke: Invoke) {
        val args = invoke.parseArgs(BioEnableArgs::class.java)
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Des empreintes ont changé depuis : on repart d'une clé neuve.
            forgetAll()
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
        } catch (e: Exception) {
            return fail(invoke, "error", e.message)
        }
        prompt(invoke, args.title, "Confirmez pour l'activer", cipher) { c ->
            val ct = c.doFinal(Base64.decode(args.secret, Base64.NO_WRAP))
            val e = JSONObject()
                .put("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
                .put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                .put("boot", bootCount())
                .put("at", System.currentTimeMillis())
            prefs.edit().putString("e:${args.id}", e.toString()).apply()
            invoke.resolve(JSObject().put("ok", true))
        }
    }

    /** Rend le secret de ce coffre, après une empreinte. */
    @Command
    fun unlock(invoke: Invoke) {
        val args = invoke.parseArgs(BioUnlockArgs::class.java)
        val e = entry(args.id) ?: return fail(invoke, "none", null)
        passwordReason(e)?.let { return fail(invoke, "password", it) }
        val key = key(create = false) ?: run {
            forgetAll()
            return fail(invoke, "invalidated", null)
        }
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(e.getString("iv"), Base64.NO_WRAP)))
            }
        } catch (x: KeyPermanentlyInvalidatedException) {
            forgetAll()
            return fail(invoke, "invalidated", null)
        } catch (x: Exception) {
            return fail(invoke, "error", x.message)
        }
        prompt(invoke, args.title, args.subtitle, cipher) { c ->
            val secret = c.doFinal(Base64.decode(e.getString("ct"), Base64.NO_WRAP))
            invoke.resolve(JSObject().put("ok", true).put("secret", Base64.encodeToString(secret, Base64.NO_WRAP)))
            secret.fill(0)
        }
    }

    // ─── Le Keystore et l'invite ────────────────────────────────────────────

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(create: Boolean): SecretKey? {
        (keyStore().getKey(KEY, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                // Une empreinte à chaque usage (le défaut avant Android 11).
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec)
            generateKey()
        }
    }

    /** La clé ne sert plus (empreintes changées) : rien de ce qu'elle
     * protégeait ne se rouvrira. */
    private fun forgetAll() {
        runCatching { keyStore().deleteEntry(KEY) }
        val edit = prefs.edit()
        prefs.all.keys.filter { it.startsWith("e:") }.forEach { edit.remove(it) }
        edit.apply()
    }

    private fun fail(invoke: Invoke, reason: String, message: String?) {
        val out = JSObject().put("ok", false).put("reason", reason)
        if (message != null) out.put("message", message)
        invoke.resolve(out)
    }

    private fun prompt(invoke: Invoke, title: String, subtitle: String?, cipher: Cipher, done: (Cipher) -> Unit) {
        activity.runOnUiThread {
            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val c = result.cryptoObject?.cipher ?: return fail(invoke, "error", "Pas de chiffrement rendu.")
                    try {
                        done(c)
                    } catch (e: Exception) {
                        fail(invoke, "error", e.message)
                    }
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    val reason = when (code) {
                        BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED -> "cancel"
                        BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
                        else -> "error"
                    }
                    fail(invoke, reason, message.toString())
                }
            }
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .apply { subtitle?.let { setSubtitle(it) } }
                .setNegativeButtonText("Mot de passe maître")
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build()
            BiometricPrompt(activity as FragmentActivity, ContextCompat.getMainExecutor(activity), callback)
                .authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }
}
