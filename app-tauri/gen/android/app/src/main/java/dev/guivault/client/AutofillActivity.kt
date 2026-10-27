package dev.guivault.client

import android.app.assist.AssistStructure
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.view.autofill.AutofillManager
import android.widget.BaseAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * L'écran du remplissage (`docs/REMPLISSAGE.md`), en feuille au bas de
 * l'écran par-dessus l'application qui demande : déverrouiller d'une
 * empreinte, chercher, choisir. Il rend à Android le jeu de valeurs à
 * remplir (`EXTRA_AUTHENTICATION_RESULT`). Pour une application sans
 * identifiant associé, « Retenir pour cette application » lie le choix à
 * son certificat de signature.
 */
class AutofillActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_PICK = "pick"
        const val MODE_UNLOCK = "unlock"
        const val MODE_OPEN = "open"
        /** Un identifiant avec TOTP, coffre ouvert : rien à montrer — copier
         * le code, rendre les valeurs. */
        const val MODE_TOTP = "totp"
        const val EXTRA_ENTRY = "entry"
    }

    private lateinit var form: AutofillForm
    private lateinit var where: String
    private val dark get() = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    private val bg get() = Color.parseColor(if (dark) "#17181D" else "#FFFFFF")
    private val surface get() = Color.parseColor(if (dark) "#22232A" else "#F2F3F6")
    private val ink get() = Color.parseColor(if (dark) "#ECEDF1" else "#17181D")
    private val muted get() = Color.parseColor(if (dark) "#9A9CA6" else "#6B6E78")
    private val accent get() = Color.parseColor(if (dark) "#8B8CFF" else "#5755D9")

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val mode = intent.getStringExtra(EXTRA_MODE)
        // Le passage du TOTP ne montre rien : pas d'assombrissement.
        if (mode != MODE_TOTP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            window.setDimAmount(0.45f)
        }
        val structure: AssistStructure? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE, AssistStructure::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        }
        if (structure == null) return cancel()
        form = AutofillForm.parse(structure)
        where = form.domain ?: AutofillIndex.appLabel(this, form.pkg)
        when (mode) {
            MODE_TOTP -> {
                val id = intent.getStringExtra(EXTRA_ENTRY)
                AutofillIndex.open()?.find { it.id == id }?.let { fill(it, remember = false) } ?: unlockOrOpen()
            }
            MODE_PICK -> AutofillIndex.open()?.let { showList(it) } ?: unlockOrOpen()
            MODE_UNLOCK -> unlockOrOpen()
            else -> showOpen(null)
        }
    }

    private fun cancel() {
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun unlockOrOpen() {
        if (AutofillIndex.stored(this) != AutofillIndex.Stored.READY) return showOpen(null)
        val cipher = AutofillIndex.unlockCipher(this) ?: return showOpen("Les empreintes du téléphone ont changé.")
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher ?: return showOpen(null)
                val entries = try {
                    AutofillIndex.openStored(this@AutofillActivity, c)
                } catch (e: Exception) {
                    null
                } ?: return showOpen(null)
                val found = AutofillIndex.matches(this@AutofillActivity, entries, form.asker)
                if (found.size == 1) fill(found[0], remember = false) else showList(entries)
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                when (code) {
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED -> cancel()
                    else -> showOpen(message.toString())
                }
            }
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Remplir avec GuiVault")
            .setSubtitle(where)
            .setNegativeButtonText("Annuler")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Rendre le jeu de valeurs à Android, qui remplit. */
    private fun fill(entry: FillEntry, remember: Boolean) {
        if (remember && form.domain == null) AutofillIndex.associate(this, form.pkg, entry.id)
        val data = Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, form.dataset(this, entry))
        setResult(RESULT_OK, data)
        // Le site demandera le code à l'écran suivant : il est déjà copié.
        entry.totp?.takeIf { Totp.copyEnabled(this) }?.let {
            Totp.copy(this, it.code())
            android.widget.Toast.makeText(this, "Code 2FA copié", android.widget.Toast.LENGTH_SHORT).show()
        }
        finish()
    }

    // ─── La feuille ─────────────────────────────────────────────────────────

    /** Le fond (toucher hors de la feuille : annuler) et la feuille, qui
     * monte du bas. */
    private fun sheet(build: (LinearLayout) -> Unit) {
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(bg)
                cornerRadii = floatArrayOf(dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), 0f, 0f, 0f, 0f)
            }
            setPadding(dp(20), dp(10), dp(20), dp(16))
            isClickable = true
        }
        // La poignée.
        sheet.addView(View(this).apply {
            background = GradientDrawable().apply {
                setColor(muted)
                cornerRadius = dp(2).toFloat()
                alpha = 90
            }
        }, LinearLayout.LayoutParams(dp(36), dp(4)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = dp(14)
        })
        build(sheet)
        val root = FrameLayout(this).apply { setOnClickListener { cancel() } }
        root.addView(sheet, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        val base = sheet.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.ime())
            sheet.setPadding(sheet.paddingLeft, sheet.paddingTop, sheet.paddingRight, base + bars.bottom)
            insets
        }
        setContentView(root)
        sheet.translationY = resources.displayMetrics.heightPixels.toFloat()
        sheet.post {
            sheet.translationY = sheet.height.toFloat()
            sheet.animate().translationY(0f).setDuration(320).setInterpolator(PathInterpolator(0.32f, 0.72f, 0f, 1f)).start()
        }
    }

    private fun header(sheet: LinearLayout, title: String, subtitle: String) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(ImageView(this).apply { setImageResource(R.mipmap.ic_launcher_round) }, LinearLayout.LayoutParams(dp(36), dp(36)))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), 0, 0, 0)
        }
        col.addView(label(title, 17f, ink, bold = true))
        col.addView(label(subtitle, 13.5f, muted))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        sheet.addView(row)
    }

    private fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun button(value: String, primary: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = value
        gravity = Gravity.CENTER
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTextColor(if (primary) Color.WHITE else ink)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        background = GradientDrawable().apply {
            setColor(if (primary) accent else surface)
            cornerRadius = dp(14).toFloat()
        }
        minHeight = dp(48)
        setOnClickListener { onClick() }
    }

    /** Rien d'ouvert : déverrouiller dans l'application, puis revenir. */
    private fun showOpen(reason: String?) = sheet { s ->
        header(s, "GuiVault est verrouillé", reason ?: "Ouvrez-le, puis revenez à ce champ")
        s.addView(button("Ouvrir GuiVault", primary = true) {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            cancel()
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
        s.addView(button("Annuler", primary = false) { cancel() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
    }

    /** Chercher et choisir : les identifiants qui correspondent en tête, puis
     * les devinés (application), puis le reste. */
    private fun showList(entries: List<FillEntry>) = sheet { s ->
        val matched = AutofillIndex.matches(this, entries, form.asker)
        val guessed = if (form.domain == null) AutofillIndex.guesses(entries, form.pkg) - matched.toSet() else emptyList()
        val ordered = matched + guessed + (entries - matched.toSet() - guessed.toSet()).sortedBy { it.name.lowercase() }
        val top = (matched + guessed).toSet()
        header(s, "Remplir avec GuiVault", where)

        val search = EditText(this).apply {
            hint = "Rechercher"
            setSingleLine()
            setTextColor(ink)
            setHintTextColor(muted)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            background = GradientDrawable().apply {
                setColor(surface)
                cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(14), dp(10), dp(14), dp(10))
        }
        s.addView(search, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        val remember = CheckBox(this).apply {
            text = "Retenir pour ${AutofillIndex.appLabel(this@AutofillActivity, form.pkg)}"
            setTextColor(muted)
            isChecked = matched.isEmpty()
            visibility = if (form.domain == null) View.VISIBLE else View.GONE
        }

        val adapter = EntryAdapter(ordered, top) { fill(it, remember.isChecked) }
        val list = ListView(this).apply {
            this.adapter = adapter
            divider = null
            isVerticalScrollBarEnabled = false
        }
        val maxHeight = (resources.displayMetrics.heightPixels * 0.5f).toInt()
        val height = minOf(maxHeight, maxOf(dp(64), ordered.size * dp(62)))
        s.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height).apply { topMargin = dp(8) })
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(e: Editable?) = adapter.filter(e?.toString().orEmpty())
        })
        s.addView(remember, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        s.addView(button("Annuler", primary = false) { cancel() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
    }

    /** Une ligne : la tuile (initiale), le nom, l'identifiant. */
    private inner class EntryAdapter(private val all: List<FillEntry>, private val top: Set<FillEntry>, private val onPick: (FillEntry) -> Unit) : BaseAdapter() {
        private var shown = all

        fun filter(q: String) {
            val needle = q.trim().lowercase()
            shown = if (needle.isEmpty()) all else all.filter { e ->
                e.name.lowercase().contains(needle) || e.username.lowercase().contains(needle) || e.uris.any { it.first.lowercase().contains(needle) }
            }
            notifyDataSetChanged()
        }

        override fun getCount() = shown.size
        override fun getItem(position: Int) = shown[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val e = shown[position]
            val row = LinearLayout(this@AutofillActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(4), dp(9), dp(4), dp(9))
                setOnClickListener { onPick(e) }
            }
            val hue = (e.name.fold(0) { h, c -> h * 31 + c.code } and 0x7fffffff) % 360
            row.addView(TextView(this@AutofillActivity).apply {
                text = e.name.trim().take(1).uppercase().ifEmpty { "?" }
                gravity = Gravity.CENTER
                setTextColor(Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.45f, if (dark) 0.95f else 0.55f)))
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                background = GradientDrawable().apply {
                    setColor(Color.HSVToColor(if (dark) 70 else 40, floatArrayOf(hue.toFloat(), 0.5f, if (dark) 0.35f else 0.9f)))
                    cornerRadius = dp(11).toFloat()
                }
            }, LinearLayout.LayoutParams(dp(40), dp(40)))
            val col = LinearLayout(this@AutofillActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), 0, 0, 0)
            }
            col.addView(label(e.name, 15f, ink, bold = e in top))
            col.addView(label(listOf(e.username, e.vault).filter { it.isNotEmpty() }.joinToString(" · "), 13f, muted))
            row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (e in top) row.addView(label("Suggéré", 12f, accent))
            return row
        }
    }
}
