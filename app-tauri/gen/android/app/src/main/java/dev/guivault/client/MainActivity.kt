package dev.guivault.client

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** Les marges du système, en px CSS : la WebView ne les donne pas à la page
   * (`env(safe-area-inset-*)` vaut 0) dans une application bord à bord. */
  @Volatile private var insets = "{\"top\":0,\"bottom\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, all ->
      val bars = all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      // Clavier ouvert : le bas remonte au-dessus de lui.
      val ime = all.getInsets(WindowInsetsCompat.Type.ime())
      val d = resources.displayMetrics.density
      insets = "{\"top\":${bars.top / d},\"bottom\":${maxOf(bars.bottom, ime.bottom) / d}}"
      (view as WebView).post { view.evaluateJavascript("window.dispatchEvent(new Event('guivault-insets'))", null) }
      all
    }
  }
}
