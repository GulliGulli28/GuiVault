package dev.guivault.client

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.InlinePresentation
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi

/**
 * Un formulaire vu par le remplissage (`docs/REMPLISSAGE.md`) : les champs
 * identifiant et mot de passe, et qui demande. Le domaine qu'annonce la
 * page n'est cru que d'un navigateur connu : une application pourrait
 * prétendre être `banque.fr` dans sa propre structure.
 */
class AutofillForm private constructor(
    val pkg: String,
    val domain: String?,
    val username: List<AutofillId>,
    val password: List<AutofillId>,
) {
    val asker get() = Asker(pkg, domain)
    val ids get() = username + password
    val empty get() = username.isEmpty() && password.isEmpty()

    companion object {
        /** Les navigateurs dont on croit le domaine annoncé. */
        val BROWSERS = setOf(
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary", "org.chromium.chrome",
            "com.brave.browser", "com.brave.browser_beta", "com.microsoft.emmx", "com.sec.android.app.sbrowser",
            "com.sec.android.app.sbrowser.beta", "com.vivaldi.browser", "com.opera.browser", "com.opera.mini.native",
            "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
            "org.mozilla.klar", "com.duckduckgo.mobile.android", "com.kiwibrowser.browser", "com.ecosia.android",
            "app.vanadium.browser", "org.bromite.bromite", "org.cromite.cromite", "com.yandex.browser", "mark.via.gp",
            "io.github.forkmaintainers.iceraven", "org.ironfoxoss.ironfox",
        )

        private enum class Kind { USER, PASSWORD, OTHER }

        private val PASSWORD_WORDS = listOf("password", "passwd", "pass", "pwd", "mot de passe", "motdepasse", "mdp", "passwort", "contraseña", "senha")
        private val USER_WORDS = listOf("username", "user", "login", "email", "e-mail", "mail", "courriel", "identifiant", "identifier", "account", "compte", "pseudo", "utilisateur")

        fun parse(structure: AssistStructure): AutofillForm {
            val pkg = structure.activityComponent.packageName
            var domain: String? = null
            val users = mutableListOf<AutofillId>()
            val passwords = mutableListOf<AutofillId>()
            // Les champs de texte dans l'ordre : l'identifiant d'un formulaire
            // sans indice est celui qui précède le mot de passe.
            val texts = mutableListOf<Pair<AutofillId, Kind>>()

            fun visit(node: AssistStructure.ViewNode) {
                node.webDomain?.let { if (domain == null && it.isNotBlank()) domain = it }
                val id = node.autofillId
                if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT && node.isEnabled && node.visibility == View.VISIBLE) {
                    val kind = classify(node)
                    texts += id to kind
                    when (kind) {
                        Kind.USER -> users += id
                        Kind.PASSWORD -> passwords += id
                        Kind.OTHER -> {}
                    }
                }
                for (i in 0 until node.childCount) visit(node.getChildAt(i))
            }
            for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)

            if (users.isEmpty() && passwords.isNotEmpty()) {
                val first = texts.indexOfFirst { it.second == Kind.PASSWORD }
                texts.take(first).lastOrNull { it.second == Kind.OTHER }?.let { users += it.first }
            }
            val trusted = if (pkg in BROWSERS) domain else null
            return AutofillForm(pkg, trusted, users, passwords)
        }

        private fun classify(node: AssistStructure.ViewNode): Kind {
            val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
            if (hints.any { it.contains("password") }) return Kind.PASSWORD
            if (hints.any { it == "username" || it.contains("email") }) return Kind.USER

            node.htmlInfo?.let { html ->
                val attrs = html.attributes?.associate { it.first.lowercase() to (it.second ?: "").lowercase() }.orEmpty()
                when (attrs["type"]) {
                    "password" -> return Kind.PASSWORD
                    "hidden", "submit", "button", "checkbox", "radio", "search" -> return Kind.OTHER
                    "email" -> return Kind.USER
                }
                val auto = attrs["autocomplete"].orEmpty()
                if (auto.contains("password")) return Kind.PASSWORD
                if (auto.contains("username") || auto.contains("email")) return Kind.USER
            }

            val type = node.inputType
            if (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT) {
                when (type and InputType.TYPE_MASK_VARIATION) {
                    InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD -> return Kind.PASSWORD
                    InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> return Kind.USER
                }
            }
            if (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER &&
                type and InputType.TYPE_MASK_VARIATION == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            ) {
                return Kind.PASSWORD
            }

            val html = node.htmlInfo?.attributes?.filter { it.first in setOf("name", "id", "placeholder", "aria-label") }?.joinToString(" ") { it.second ?: "" }.orEmpty()
            val words = listOfNotNull(node.idEntry, node.hint, node.contentDescription?.toString(), html).joinToString(" ").lowercase()
            if (PASSWORD_WORDS.any { words.contains(it) } && !words.contains("passport")) return Kind.PASSWORD
            if (USER_WORDS.any { words.contains(it) }) return Kind.USER
            return Kind.OTHER
        }

        // ─── Ce qu'Android affiche ──────────────────────────────────────────

        /** La ligne sous le champ (liste déroulante). */
        fun presentation(context: Context, title: String, subtitle: String): RemoteViews =
            RemoteViews(context.packageName, R.layout.autofill_item).apply {
                setTextViewText(R.id.autofill_title, title)
                setTextViewText(R.id.autofill_subtitle, subtitle)
            }

        /** La suggestion dans la barre du clavier (Android 11+), si le clavier
         * en veut. */
        fun inline(context: Context, spec: InlinePresentationSpec?, title: String, subtitle: String): InlinePresentation? {
            if (spec == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
            if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
            // Ce qu'ouvre un appui long sur la suggestion : GuiVault.
            val attribution = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val content = InlineSuggestionUi.newContentBuilder(attribution)
                .setTitle(title)
                .setStartIcon(Icon.createWithResource(context, R.mipmap.ic_launcher_round))
                .apply { if (subtitle.isNotEmpty()) setSubtitle(subtitle) }
                .build()
            return InlinePresentation(content.slice, spec, false)
        }
    }

    /** Un jeu de valeurs : l'identifiant et le mot de passe de `entry` dans
     * les champs du formulaire. */
    @Suppress("DEPRECATION")
    fun dataset(context: Context, entry: FillEntry, spec: InlinePresentationSpec? = null): Dataset {
        val subtitle = entry.username.ifEmpty { entry.vault }
        val pres = presentation(context, entry.name, subtitle)
        val inl = inline(context, spec, entry.name, subtitle)
        val b = Dataset.Builder(pres)
        fun put(id: AutofillId, value: String) {
            if (inl != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setValue(id, AutofillValue.forText(value), pres, inl)
            else b.setValue(id, AutofillValue.forText(value), pres)
        }
        if (entry.username.isNotEmpty()) username.forEach { put(it, entry.username) }
        password.forEach { put(it, entry.password) }
        // Un formulaire sans champ rempli par cet identifiant : au moins une
        // valeur, sans quoi Android refuse le jeu.
        if (entry.username.isEmpty() && password.isEmpty()) username.forEach { put(it, "") }
        return b.build()
    }

    /** Un jeu qui ouvre GuiVault (déverrouiller, chercher) avant de remplir :
     * `sender` lance [AutofillActivity], qui rend le vrai jeu. */
    @Suppress("DEPRECATION")
    fun gate(context: Context, title: String, subtitle: String, sender: android.content.IntentSender, spec: InlinePresentationSpec? = null): Dataset {
        val pres = presentation(context, title, subtitle)
        val inl = inline(context, spec, title, subtitle)
        val b = Dataset.Builder(pres)
        for (id in ids) {
            if (inl != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setValue(id, null, pres, inl) else b.setValue(id, null, pres)
        }
        b.setAuthentication(sender)
        return b.build()
    }
}
