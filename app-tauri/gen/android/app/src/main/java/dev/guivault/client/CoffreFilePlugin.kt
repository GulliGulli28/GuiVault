package dev.guivault.client

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

@InvokeArg
class SaveArgs {
    /** La copie du coffre à archiver (`local_export_snapshot`, dans le cache). */
    lateinit var dir: String
    /** Le nom proposé, sans extension. */
    lateinit var name: String
}

@InvokeArg
class PickArgs {
    /** Le dossier vide où décompresser (`local_staging`, dans le cache). */
    lateinit var into: String
}

/**
 * Sortir un coffre de l'appareil, en faire entrer un (`docs/ANDROID.md`) :
 * les coffres vivent dans le dossier privé de l'application, que la
 * désinstallation efface. Le sélecteur de documents d'Android (Storage
 * Access Framework) choisit où ranger l'archive — Téléchargements, Drive,
 * Nextcloud… — ou laquelle importer, sans aucune permission de stockage.
 *
 * L'archive est un zip du dossier du coffre (`<nom>.guivault/coffre.json`,
 * `attachments/…`) : chiffré comme sur l'appareil, il s'ouvre au bureau une
 * fois décompressé, ou par `gv recover`. Rien n'est déchiffré ici ; ce que
 * l'archive contient, Rust le vérifie avant de l'adopter
 * (`guivault_local::import_coffre`).
 */
@TauriPlugin
class CoffreFilePlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Au-delà, une archive n'est pas un coffre (et remplirait le téléphone). */
        private const val MAX_BYTES = 4L * 1024 * 1024 * 1024
        private const val MAX_ENTRIES = 200_000
    }

    /** Enregistrer l'archive : le système demande où. `saved: false` si on annule. */
    @Command
    fun save(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(Intent.EXTRA_TITLE, "${args.name}.zip")
        }
        startActivityForResult(invoke, intent, "saveResult")
    }

    @ActivityCallback
    fun saveResult(invoke: Invoke, result: ActivityResult) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        val dir = File(args.dir)
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            discard(dir)
            invoke.resolve(JSObject().put("saved", false))
            return
        }
        // Hors du fil de l'interface : des pièces jointes peuvent peser.
        Thread {
            try {
                val out = activity.contentResolver.openOutputStream(uri, "wt")
                    ?: throw IllegalStateException("le document choisi ne s'ouvre pas en écriture")
                out.use { zip(dir, it) }
                invoke.resolve(JSObject().put("saved", true).put("name", displayName(uri) ?: "${args.name}.zip"))
            } catch (e: Exception) {
                invoke.reject("Export impossible : ${e.message}")
            } finally {
                discard(dir)
            }
        }.start()
    }

    /** Choisir une archive de coffre (ou un `coffre.json`) et la décompresser
     * dans `into`. `picked: false` si on annule. */
    @Command
    fun pick(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Drive et les autres fournisseurs donnent des types variables :
            // tout se choisit, le contenu décide.
            type = "*/*"
        }
        startActivityForResult(invoke, intent, "pickResult")
    }

    @ActivityCallback
    fun pickResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject().put("picked", false))
            return
        }
        val into = File(invoke.parseArgs(PickArgs::class.java).into)
        Thread {
            try {
                val input = activity.contentResolver.openInputStream(uri)
                    ?: throw IllegalStateException("le document choisi ne s'ouvre pas")
                BufferedInputStream(input).use { unpack(it, into) }
                val name = (displayName(uri) ?: "Coffre importé")
                    .replace(Regex("""(\.zip|\.json)$""", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("""\.guivault$""", RegexOption.IGNORE_CASE), "")
                    .ifBlank { "Coffre importé" }
                invoke.resolve(JSObject().put("picked", true).put("name", name))
            } catch (e: java.util.zip.ZipException) {
                // Android 14+ refuse lui-même un nom en `../` (« Invalid zip
                // entry path »), avant notre propre vérification.
                into.deleteRecursively()
                invoke.reject("Archive refusée, abîmée ou piégée (${e.message}).")
            } catch (e: Exception) {
                into.deleteRecursively()
                invoke.reject(e.message ?: "Import impossible")
            }
        }.start()
    }

    /** La copie archivée, et son dossier `export/<horodatage>` s'il est vide. */
    private fun discard(dir: File) {
        dir.deleteRecursively()
        dir.parentFile?.delete()
    }

    private fun displayName(uri: Uri): String? =
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    /** Le dossier `dir` dans l'archive, sous son propre nom. */
    private fun zip(dir: File, out: OutputStream) {
        ZipOutputStream(out).use { zip ->
            val root = dir.parentFile ?: dir
            dir.walkTopDown().filter { it.isFile && it.name != ".lock" }.forEach { f ->
                zip.putNextEntry(ZipEntry(f.relativeTo(root).invariantSeparatorsPath))
                f.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /** Un zip (décompressé dans `into`, sans jamais en sortir) ou un
     * `coffre.json` seul ; autre chose est refusé. */
    private fun unpack(input: BufferedInputStream, into: File) {
        into.mkdirs()
        input.mark(4)
        val head = ByteArray(2)
        val n = input.read(head)
        input.reset()
        when {
            n == 2 && head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte() -> unzip(input, into)
            n >= 1 && head[0] == '{'.code.toByte() -> File(into, "coffre.json").outputStream().use { copyBounded(input, it) }
            else -> throw IllegalArgumentException("Ni une archive de coffre (.zip), ni un coffre.json.")
        }
    }

    private fun unzip(input: InputStream, into: File) {
        val base = into.canonicalFile
        var entries = 0
        var total = 0L
        ZipInputStream(input).use { zip ->
            while (true) {
                val e = zip.nextEntry ?: break
                if (++entries > MAX_ENTRIES) throw IllegalArgumentException("Archive trop grande pour un coffre.")
                val target = File(base, e.name).canonicalFile
                // « Zip slip » : un nom en `../` ou absolu ne sort pas du dossier.
                if (!target.path.startsWith(base.path + File.separator)) {
                    throw IllegalArgumentException("Archive refusée : « ${e.name} » sort de son dossier.")
                }
                if (e.isDirectory) {
                    target.mkdirs()
                } else {
                    target.parentFile?.mkdirs()
                    total += target.outputStream().use { copyBounded(zip, it, MAX_BYTES - total) }
                }
            }
        }
    }

    private fun copyBounded(input: InputStream, out: OutputStream, limit: Long = MAX_BYTES): Long {
        val buf = ByteArray(64 * 1024)
        var copied = 0L
        while (true) {
            val r = input.read(buf)
            if (r < 0) return copied
            copied += r
            if (copied > limit) throw IllegalArgumentException("Archive trop grande pour un coffre.")
            out.write(buf, 0, r)
        }
    }
}
