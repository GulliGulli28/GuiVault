package dev.guivault.client

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import org.json.JSONObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Le TOTP d'un identifiant (RFC 6238), tel que l'interface le confie à
 * l'index (`web/src/lib/autofill.ts`, `autofillTotp`) : copié juste après
 * avoir rempli, comme Bitwarden — le site demande le code à l'écran suivant.
 */
data class Totp(val secret: ByteArray, val algorithm: String, val digits: Int, val period: Int) {

    /** Le code de l'instant `now` (millisecondes). */
    fun code(now: Long = System.currentTimeMillis()): String {
        val counter = now / 1000 / period
        val msg = ByteArray(8) { i -> (counter ushr (8 * (7 - i))).toByte() }
        val mac = Mac.getInstance("Hmac$algorithm").apply { init(SecretKeySpec(secret, "RAW")) }.doFinal(msg)
        val off = mac.last().toInt() and 0x0f
        val bin = ((mac[off].toInt() and 0x7f) shl 24) or ((mac[off + 1].toInt() and 0xff) shl 16) or
            ((mac[off + 2].toInt() and 0xff) shl 8) or (mac[off + 3].toInt() and 0xff)
        var mod = 1
        repeat(digits) { mod *= 10 }
        return (bin % mod).toString().padStart(digits, '0')
    }

    companion object {
        private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        private const val PREFS = "guivault.autofill"
        private const val KEY_COPY = "copyTotp"
        /** Effacé du presse-papiers au bout de ce délai, s'il y est encore. */
        private const val CLEAR_MS = 60_000L

        fun fromJson(o: JSONObject): Totp? = try {
            val algorithm = o.optString("algorithm", "SHA1").takeIf { it in setOf("SHA1", "SHA256", "SHA512") } ?: "SHA1"
            Totp(base32(o.getString("secret")), algorithm, o.optInt("digits", 6).coerceIn(6, 10), o.optInt("period", 30).coerceAtLeast(1))
        } catch (e: Exception) {
            null
        }

        fun base32(s: String): ByteArray {
            val out = java.io.ByteArrayOutputStream()
            var bits = 0
            var value = 0
            for (c in s.uppercase()) {
                val v = B32.indexOf(c)
                if (v < 0) continue
                value = (value shl 5) or v
                bits += 5
                if (bits >= 8) {
                    out.write((value ushr (bits - 8)) and 0xff)
                    bits -= 8
                }
            }
            return out.toByteArray()
        }

        /** Copier le code après avoir rempli (Réglages › Remplissage) : oui
         * par défaut. */
        fun copyEnabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_COPY, true)

        fun setCopyEnabled(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_COPY, on).apply()
        }

        /** Copie le code, marqué sensible (masqué dans l'aperçu d'Android
         * 13+), et l'efface au bout d'une minute s'il est encore là. */
        fun copy(context: Context, code: String) {
            val cm = context.getSystemService(ClipboardManager::class.java) ?: return
            val clip = ClipData.newPlainText("GuiVault", code)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
                }
            }
            cm.setPrimaryClip(clip)
            Handler(Looper.getMainLooper()).postDelayed({
                try {
                    val now = cm.primaryClip?.getItemAt(0)?.text?.toString()
                    if (now == code) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
                    }
                } catch (e: Exception) {
                    // Android refuse de relire le presse-papiers en arrière-plan : il reste.
                }
            }, CLEAR_MS)
        }
    }
}
