package dev.guivault.client

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class AutofillUpdateArgs {
    lateinit var index: String
}

@InvokeArg
class AutofillOfferArgs {
    var enabled: Boolean = true
}

/**
 * Le remplissage automatique vu de l'interface (`docs/REMPLISSAGE.md`) :
 * savoir si GuiVault est le service choisi, le faire choisir, lui confier
 * l'index du coffre ouvert ([AutofillIndex]) et le reprendre.
 */
@TauriPlugin
class AutofillPlugin(private val activity: Activity) : Plugin(activity) {

    private fun manager(): AutofillManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity.getSystemService(AutofillManager::class.java) else null

    /** `supported` : le téléphone le permet ; `enabled` : GuiVault est le
     * service choisi ; `biometric` : l'index peut se garder chiffré (remplir
     * l'application fermée). */
    @Command
    fun status(invoke: Invoke) {
        val m = manager()
        val supported = m?.isAutofillSupported == true
        invoke.resolve(
            JSObject()
                .put("supported", supported)
                .put("enabled", supported && m?.hasEnabledAutofillServices() == true)
                .put("biometric", BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS)
                .put("offerSave", PendingSave.offer(activity))
                .put("copyTotp", Totp.copyEnabled(activity)),
        )
    }

    /** L'écran d'Android qui propose de choisir GuiVault. */
    @Command
    fun request(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${activity.packageName}"))
            try {
                activity.startActivity(intent)
            } catch (e: Exception) {
                activity.startActivity(Intent(Settings.ACTION_SETTINGS))
            }
        }
        invoke.resolve()
    }

    /** Ne plus être le service de remplissage ; l'index s'efface. */
    @Command
    fun disable(invoke: Invoke) {
        manager()?.let { if (it.hasEnabledAutofillServices()) it.disableAutofillServices() }
        AutofillIndex.forget(activity)
        invoke.resolve()
    }

    @Command
    fun update(invoke: Invoke) {
        val args = invoke.parseArgs(AutofillUpdateArgs::class.java)
        if (manager()?.hasEnabledAutofillServices() == true) AutofillIndex.update(activity, args.index) else AutofillIndex.forget(activity)
        invoke.resolve()
    }

    @Command
    fun clear(invoke: Invoke) {
        AutofillIndex.clear()
        invoke.resolve()
    }

    @Command
    fun forget(invoke: Invoke) {
        AutofillIndex.forget(activity)
        invoke.resolve()
    }

    /** La connexion qu'Android a proposé d'enregistrer ([PendingSave]),
     * retirée : l'interface ouvre le formulaire pré-rempli. */
    @Command
    fun pending(invoke: Invoke) {
        val login = PendingSave.take() ?: return invoke.resolve(JSObject().put("login", null as Any?))
        invoke.resolve(
            JSObject().put(
                "login",
                JSObject()
                    .put("username", login.username)
                    .put("password", login.password)
                    .put("domain", login.domain)
                    .put("pkg", login.pkg)
                    .put("label", login.label),
            ),
        )
    }

    /** Proposer « Enregistrer dans GuiVault ? » ou non. */
    @Command
    fun offer(invoke: Invoke) {
        val args = invoke.parseArgs(AutofillOfferArgs::class.java)
        PendingSave.setOffer(activity, args.enabled)
        invoke.resolve()
    }

    /** Copier le code 2FA après avoir rempli, ou non. */
    @Command
    fun totp(invoke: Invoke) {
        val args = invoke.parseArgs(AutofillOfferArgs::class.java)
        Totp.setCopyEnabled(activity, args.enabled)
        invoke.resolve()
    }

    /** Le mot de passe maître vient d'ouvrir un coffre. */
    @Command
    fun password(invoke: Invoke) {
        AutofillIndex.passwordUsed(activity)
        invoke.resolve()
    }
}
