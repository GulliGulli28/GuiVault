package dev.guivault.client

import android.content.Context

/**
 * Une connexion à enregistrer (« Enregistrer dans GuiVault ? »,
 * `docs/REMPLISSAGE.md`) : en mémoire seulement, le temps que GuiVault
 * s'ouvre et que son interface la prenne ([AutofillPlugin.pending]) —
 * jamais sur le disque ni dans un intent. Dix minutes au plus.
 */
object PendingSave {
    data class Login(val username: String, val password: String, val domain: String?, val pkg: String, val label: String)

    private const val TTL_MS = 10 * 60 * 1000L
    private const val PREFS = "guivault.autofill"
    private const val KEY_OFFER = "offerSave"

    @Volatile private var pending: Pair<Login, Long>? = null

    fun put(login: Login) {
        pending = login to System.currentTimeMillis()
    }

    /** La connexion en attente, retirée ; `null` s'il n'y en a pas ou
     * qu'elle a trop attendu. */
    fun take(): Login? {
        val p = pending ?: return null
        pending = null
        return p.first.takeIf { System.currentTimeMillis() - p.second < TTL_MS }
    }

    /** Proposer d'enregistrer (Réglages › Remplissage) : oui par défaut. */
    fun offer(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_OFFER, true)

    fun setOffer(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_OFFER, on).apply()
    }
}
