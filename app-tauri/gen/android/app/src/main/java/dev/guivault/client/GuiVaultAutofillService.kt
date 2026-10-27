package dev.guivault.client

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.widget.inline.InlinePresentationSpec

/**
 * Le service de remplissage d'Android (`docs/REMPLISSAGE.md`) : choisi
 * dans les réglages du téléphone, il propose les identifiants de GuiVault
 * sous les champs des autres applications et dans la barre du clavier.
 *
 * - Coffre ouvert dans l'application : les identifiants qui correspondent,
 *   remplis d'un toucher, plus « Chercher dans GuiVault ».
 * - Sinon, l'index chiffré du disque : « Déverrouiller GuiVault » → une
 *   empreinte, puis on remplit.
 * - Sinon : « Ouvrir GuiVault », pour déverrouiller dans l'application.
 *
 * Un mot de passe tapé à la main (pas rempli par GuiVault) : Android
 * propose « Enregistrer dans GuiVault ? » ([onSaveRequest]). Le service ne
 * sait pas écrire dans le coffre (pas de clé) : il garde la saisie en
 * mémoire ([PendingSave]) et ouvre GuiVault, dont l'interface la reprend
 * (`autofillBridge.takeSave`, commande `pending`) et ouvre le formulaire pré-rempli.
 */
class GuiVaultAutofillService : AutofillService() {

    override fun onFillRequest(request: FillRequest, cancellation: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val form = AutofillForm.parse(structure)
        if (form.empty || form.pkg == packageName) return callback.onSuccess(null)

        val specs: List<InlinePresentationSpec> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) request.inlineSuggestionsRequest?.inlinePresentationSpecs.orEmpty() else emptyList()
        val maxInline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) request.inlineSuggestionsRequest?.maxSuggestionCount ?: 0 else 0
        var shown = 0
        fun spec(): InlinePresentationSpec? {
            if (specs.isEmpty() || shown >= maxInline) return null
            return specs[minOf(shown++, specs.size - 1)]
        }

        val response = FillResponse.Builder()
        val where = form.domain ?: AutofillIndex.appLabel(this, form.pkg)
        val open = AutofillIndex.open()
        if (open != null) {
            val found = AutofillIndex.matches(this, open, form.asker).take(4)
            val copyTotp = Totp.copyEnabled(this)
            for (entry in found) {
                // Avec un TOTP : un passage invisible par GuiVault, qui copie
                // le code puis rend les valeurs ([AutofillActivity.MODE_TOTP]).
                val ds = if (copyTotp && entry.totp != null) {
                    form.dataset(this, entry, spec(), sender(AutofillActivity.MODE_TOTP, entry.id))
                } else {
                    form.dataset(this, entry, spec())
                }
                response.addDataset(ds)
            }
            response.addDataset(form.gate(this, "Chercher dans GuiVault", where, sender(AutofillActivity.MODE_PICK), spec()))
        } else {
            when (AutofillIndex.stored(this)) {
                AutofillIndex.Stored.READY ->
                    response.addDataset(form.gate(this, "Déverrouiller GuiVault", "Empreinte · $where", sender(AutofillActivity.MODE_UNLOCK), spec()))
                AutofillIndex.Stored.PASSWORD ->
                    response.addDataset(form.gate(this, "GuiVault", "Mot de passe requis · ouvrir", sender(AutofillActivity.MODE_OPEN), spec()))
                AutofillIndex.Stored.NONE ->
                    response.addDataset(form.gate(this, "GuiVault", "Ouvrir pour déverrouiller", sender(AutofillActivity.MODE_OPEN), spec()))
            }
        }
        // Un mot de passe saisi à la main : Android proposera de
        // l'enregistrer quand le formulaire part (ou disparaît, page web).
        if (form.password.isNotEmpty() && PendingSave.offer(this)) {
            val types = SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (form.username.isNotEmpty()) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
            val save = SaveInfo.Builder(types, form.password.toTypedArray())
            if (form.username.isNotEmpty()) save.setOptionalIds(form.username.toTypedArray())
            save.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
            response.setSaveInfo(save.build())
        }
        callback.onSuccess(response.build())
    }

    /** « Enregistrer dans GuiVault » accepté : la saisie attend l'interface
     * en mémoire, l'intent qui ouvre GuiVault ne porte rien. */
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess()
        val form = AutofillForm.parse(structure)
        val password = AutofillForm.textOf(structure, form.password)
        if (password == null || form.pkg == packageName) return callback.onSuccess()
        PendingSave.put(
            PendingSave.Login(
                username = AutofillForm.textOf(structure, form.username).orEmpty(),
                password = password,
                domain = form.domain,
                pkg = form.pkg,
                label = form.domain ?: AutofillIndex.appLabel(this, form.pkg),
            ),
        )
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            callback.onSuccess(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE).intentSender)
        } else {
            callback.onSuccess()
            startActivity(open)
        }
    }

    /** L'écran de GuiVault qui rend un jeu de valeurs. Mutable : Android y
     * ajoute la structure du formulaire. */
    private fun sender(mode: String, entry: String? = null) = PendingIntent.getActivity(
        this,
        (mode + (entry ?: "")).hashCode(),
        Intent(this, AutofillActivity::class.java).putExtra(AutofillActivity.EXTRA_MODE, mode).putExtra(AutofillActivity.EXTRA_ENTRY, entry),
        PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0),
    ).intentSender
}
