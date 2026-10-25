package dev.guivault.client

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.provider.Settings
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** Les marges du système, en px CSS : la WebView ne les donne pas à la page
   * (`env(safe-area-inset-*)` vaut 0) dans une application bord à bord. */
  @Volatile private var insets = "{\"top\":0,\"bottom\":0,\"ime\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /** On quitte l'application (accueil, récentes, une autre appli ouverte
   * d'ici) : la bulle, si le réglage le veut et que la permission est
   * donnée. L'activité est encore au premier plan à cet instant. */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (BubbleService.autoEnabled(this) && Settings.canDrawOverlays(this)) {
      // L'image de la fenêtre : la rouvrir depuis la bulle la fera grandir.
      BubbleService.capture(this)
      BubbleService.start(this)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    // Lu par `web/app/src/mobile.ts` au démarrage, puis à chaque avis.
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun get(): String = insets

      /** Le thème de la page : icônes claires de la barre d'état sur un
       * fond sombre, sombres sur un fond clair (Android suit sinon celui du
       * système). */
      @JavascriptInterface
      fun setDark(dark: Boolean) {
        runOnUiThread {
          val bars = WindowCompat.getInsetsController(window, window.decorView)
          bars.isAppearanceLightStatusBars = !dark
          bars.isAppearanceLightNavigationBars = !dark
        }
      }
    }, "GuiVaultInsets")
    // Ce que seule l'application sait faire du système (`web/app/src/android.ts`).
    webView.addJavascriptInterface(object {
      /** Ni capture d'écran, ni aperçu dans les applications récentes, tant
       * qu'un coffre est ouvert (réglable : Réglages › Écran). */
      @JavascriptInterface
      fun setSecure(on: Boolean) {
        runOnUiThread {
          if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
          else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
      }

      /** Copier un secret : marqué sensible (pas d'aperçu dans l'avis du
       * système, Android 13+), effacé à l'échéance s'il est encore là. */
      @JavascriptInterface
      fun copySecret(text: String, clearAfterMs: Long) {
        runOnUiThread { copySensitive(text, clearAfterMs) }
      }
    }, "GuiVaultAndroid")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, all ->
      val bars = all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      // Le clavier à part : la page se raccourcit, les onglets se cachent.
      val ime = all.getInsets(WindowInsetsCompat.Type.ime())
      val d = resources.displayMetrics.density
      insets = "{\"top\":${bars.top / d},\"bottom\":${bars.bottom / d},\"ime\":${ime.bottom / d}}"
      (view as WebView).post { view.evaluateJavascript("window.dispatchEvent(new Event('guivault-insets'))", null) }
      all
    }
  }

  private fun copySensitive(text: String, clearAfterMs: Long) {
    val cm = getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText("GuiVault", text)
    clip.description.extras = PersistableBundle().apply {
      putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
    }
    cm.setPrimaryClip(clip)
    if (clearAfterMs <= 0) return
    Handler(Looper.getMainLooper()).postDelayed({
      // Seulement s'il est encore à nous. En arrière-plan, Android ne laisse
      // pas relire le presse-papiers : on ne vide alors rien plutôt que
      // d'effacer ce qu'on aurait copié ailleurs (Android 13+ l'efface de
      // lui-même au bout d'une heure).
      val current = runCatching { cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString() }.getOrNull()
      if (current == text) {
        if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
      }
    }, clearAfterMs)
  }
}
