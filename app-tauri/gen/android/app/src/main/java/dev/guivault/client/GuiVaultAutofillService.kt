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
            for (entry in found) response.addDataset(form.dataset(this, entry, spec()))
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
        callback.onSuccess(response.build())
    }

    /** « Enregistrer dans GuiVault ? » n'est pas encore là : rien n'est
     * demandé (pas de `SaveInfo`), rien n'arrive ici. */
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onSuccess()
    }

    /** L'écran de GuiVault qui rend un jeu de valeurs. Mutable : Android y
     * ajoute la structure du formulaire. */
    private fun sender(mode: String) = PendingIntent.getActivity(
        this,
        mode.hashCode(),
        Intent(this, AutofillActivity::class.java).putExtra(AutofillActivity.EXTRA_MODE, mode),
        PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0),
    ).intentSender
}
