package dev.guivault.client

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class LockedArgs {
    var locked: Boolean = true
}

@InvokeArg
class AutoArgs {
    var enabled: Boolean? = null
}

/**
 * La bulle flottante (`docs/ANDROID.md`), vue de l'interface : savoir si
 * elle est possible, demander la permission « Afficher par-dessus d'autres
 * applis », réduire l'application en bulle, la retirer, la griser quand le
 * coffre est verrouillé. Le dessin et les gestes sont dans [BubbleService].
 */
@TauriPlugin
class BubblePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun available(invoke: Invoke) {
        invoke.resolve(JSObject().put("value", true))
    }

    /** La permission est-elle donnée ? */
    @Command
    fun allowed(invoke: Invoke) {
        invoke.resolve(JSObject().put("value", Settings.canDrawOverlays(activity)))
    }

    /** Ouvre l'écran d'Android qui donne la permission à GuiVault. */
    @Command
    fun ask(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
        activity.startActivity(intent)
        invoke.resolve()
    }

    /** Réduit l'application : la bulle apparaît, GuiVault passe derrière. */
    @Command
    fun show(invoke: Invoke) {
        if (!Settings.canDrawOverlays(activity)) {
            invoke.reject("La permission « Afficher par-dessus d'autres applis » manque.")
            return
        }
        BubbleService.start(activity)
        activity.moveTaskToBack(true)
        invoke.resolve()
    }

    /** Où la bulle va apparaître (son centre, px CSS) : l'interface y fait
     * converger son animation avant de se réduire. */
    @Command
    fun anchor(invoke: Invoke) {
        val (x, y) = BubbleService.anchor(activity)
        invoke.resolve(JSObject().put("x", x.toDouble()).put("y", y.toDouble()))
    }

    @Command
    fun hide(invoke: Invoke) {
        activity.stopService(Intent(activity, BubbleService::class.java))
        invoke.resolve()
    }

    /** Grise (ou non) la bulle : verrouillé, elle ne promet rien d'ouvert. */
    @Command
    fun locked(invoke: Invoke) {
        val args = invoke.parseArgs(LockedArgs::class.java)
        BubbleService.setLocked(args.locked)
        invoke.resolve()
    }

    /** Se réduire en bulle en quittant l'application : lit le réglage, ou le
     * pose (`enabled`). Rend aussi si la permission est donnée. */
    @Command
    fun auto(invoke: Invoke) {
        val args = invoke.parseArgs(AutoArgs::class.java)
        args.enabled?.let { BubbleService.setAutoEnabled(activity, it) }
        invoke.resolve(
            JSObject()
                .put("enabled", BubbleService.autoEnabled(activity))
                .put("allowed", Settings.canDrawOverlays(activity)),
        )
    }

    /** GuiVault revient au premier plan (par la bulle ou autrement) : plus
     * de bulle. */
    override fun onResume() {
        super.onResume()
        activity.stopService(Intent(activity, BubbleService::class.java))
    }
}
