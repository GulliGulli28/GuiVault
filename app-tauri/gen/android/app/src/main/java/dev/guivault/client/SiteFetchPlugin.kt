package dev.guivault.client

import android.app.Activity
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

@InvokeArg
class SiteFetchArgs {
    lateinit var url: String
}

/**
 * Les icônes des sites (`web/src/lib/siteIcon.ts`) sur Android : lire la
 * page d'accueil ou l'icône d'un site, ce que la WebView ne peut pas (CORS).
 * Le pendant de `site_fetch.rs` au bureau, avec la pile HTTPS du système
 * (ses certificats, sans rien à initialiser). Un `GET` sans cookies (aucun
 * `CookieHandler` n'est posé), au site lui-même — jamais au serveur GuiVault
 * ni à un tiers —, borné en temps et en taille. Le réglage qui l'autorise
 * est désactivé par défaut.
 */
@TauriPlugin
class SiteFetchPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Le même plafond que `MAX_FETCH_BYTES`. */
        private const val MAX_BYTES = 512 * 1024
        private const val TIMEOUT_MS = 8000
        private const val MAX_REDIRECTS = 5
    }

    /** Hors du fil principal : une requête réseau n'y a pas sa place. */
    private val pool = Executors.newSingleThreadExecutor()

    @Command
    fun fetch(invoke: Invoke) {
        val args = invoke.parseArgs(SiteFetchArgs::class.java)
        pool.execute {
            try {
                invoke.resolve(get(args.url))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "échec de la requête")
            }
        }
    }

    private fun get(start: String): JSObject {
        var url = URL(start)
        // Les redirections à la main : HttpURLConnection ne suit pas un
        // passage de http à https.
        repeat(MAX_REDIRECTS + 1) {
            if (url.protocol != "http" && url.protocol != "https") throw IllegalArgumentException("adresse non http(s)")
            val c = url.openConnection() as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.connectTimeout = TIMEOUT_MS
                c.readTimeout = TIMEOUT_MS
                c.useCaches = false
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; GuiVault)")
                val code = c.responseCode
                if (code in 300..399) {
                    val location = c.getHeaderField("Location") ?: throw IllegalStateException("redirection sans adresse")
                    url = URL(url, location)
                    return@repeat
                }
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                if (c.contentLengthLong > MAX_BYTES) throw IllegalStateException("réponse trop grande")
                val out = ByteArrayOutputStream()
                c.inputStream.use { input ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_BYTES) throw IllegalStateException("réponse trop grande")
                    }
                }
                val r = JSObject()
                r.put("url", url.toString())
                r.put("type", c.contentType ?: "")
                r.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                return r
            } finally {
                c.disconnect()
            }
        }
        throw IllegalStateException("trop de redirections")
    }
}
