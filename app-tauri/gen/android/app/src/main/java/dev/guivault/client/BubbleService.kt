package dev.guivault.client

import android.animation.ValueAnimator
import android.app.Activity
import android.app.ActivityOptions
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.VelocityTracker
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * La bulle elle-même : une fenêtre de superposition (`TYPE_APPLICATION_OVERLAY`)
 * tenue par un service au premier plan, comme les « chat heads » de
 * Messenger. Tout bouge sur des ressorts (`SpringAnimation`) : elle arrive en
 * rebondissant, se lance d'un geste vers un bord, se laisse aimanter par la
 * croix du bas qui la ferme. Elle retient sa place (bord et hauteur) d'une
 * fois sur l'autre. Elle ne montre que le logo — gris quand le coffre est
 * verrouillé.
 *
 * Entre la bulle et le plein écran, c'est elle qui anime (Android n'accorde
 * pas d'animation propre à une tâche ramenée au premier plan par un
 * service) : une image de la fenêtre de GuiVault, prise en la quittant
 * ([capture]), grandit depuis la bulle par-dessus l'autre application, puis
 * la vraie fenêtre prend sa place dessous ; « Réduire en bulle » fait
 * l'inverse ([collapse]). Verrouillé, aucune image n'est gardée : c'est le
 * logo qui grandit, sur le fond de l'application.
 */
class BubbleService : Service() {

    companion object {
        const val EXTRA_LOCKED = "locked"
        private const val CHANNEL = "bulle"
        private const val NOTIFICATION_ID = 7

        /** L'état du coffre, tel que l'interface l'a dit en dernier. */
        @Volatile
        var locked: Boolean = true
            private set
        private var current: BubbleService? = null

        fun setLocked(value: Boolean) {
            val changed = locked != value
            locked = value
            // Une image d'un coffre ouvert ne survit pas au verrouillage.
            if (value) snapshot = null
            if (changed) current?.let { s -> s.bubble?.post { s.paint(animate = true) } }
        }

        private const val EXTRA_COLLAPSE = "collapse"

        /** La dernière image de la fenêtre de GuiVault, et où elle était sur
         * l'écran ; jamais gardée coffre verrouillé. */
        @Volatile
        private var snapshot: Bitmap? = null
        private val snapshotAt = RectF()
        /** Le fond de l'application (pris sur l'image), pour grandir sans elle. */
        private var backdrop = Color.parseColor("#101115")
        /** Ce que fait le plugin une fois l'écran couvert : passer derrière. */
        private var afterCover: (() -> Unit)? = null

        /** Photographie la fenêtre de l'activité, puis `then` (fil principal),
         * qu'une image ait été prise ou non. */
        fun capture(activity: Activity, then: () -> Unit = {}) {
            val decor = activity.window.decorView
            val w = decor.width
            val h = decor.height
            if (locked || w == 0 || h == 0 || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                snapshot = null
                then()
                return
            }
            val at = IntArray(2)
            decor.getLocationOnScreen(at)
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            try {
                PixelCopy.request(activity.window, bitmap, { result ->
                    if (result == PixelCopy.SUCCESS && !locked) {
                        // La fenêtre est translucide (bulle) : l'image, elle, est pleine.
                        bitmap.setHasAlpha(false)
                        snapshot = bitmap
                        snapshotAt.set(at[0].toFloat(), at[1].toFloat(), (at[0] + w).toFloat(), (at[1] + h).toFloat())
                        backdrop = bitmap.getPixel(w / 2, h - 1) or 0xFF000000.toInt()
                    } else {
                        snapshot = null
                    }
                    then()
                }, Handler(Looper.getMainLooper()))
            } catch (e: Exception) {
                snapshot = null
                then()
            }
        }

        /** « Réduire en bulle » : l'application rétrécit jusqu'à la bulle.
         * `goBack` (passer derrière) est appelé une fois l'écran couvert par
         * son image, pour que l'animation du système ne se voie pas. */
        fun collapse(activity: Activity, goBack: () -> Unit) {
            capture(activity) {
                if (snapshot == null) {
                    start(activity)
                    goBack()
                } else {
                    afterCover = goBack
                    start(activity, collapse = true)
                }
            }
        }

        /** GuiVault revient au premier plan : si la bulle l'a ouvert en
         * grandissant, son image s'efface sur la vraie fenêtre ; sinon, plus
         * de bulle. */
        fun appResumed(activity: Activity) {
            val s = current
            if (s != null && s.opening) s.finishOpen(activity.window.decorView) else activity.stopService(Intent(activity, BubbleService::class.java))
        }

        private const val PREFS = "guivault_bubble"
        private const val AUTO = "auto"
        private const val SIDE = "side"
        private const val Y = "y"

        /** Le diamètre de la bulle, et la marge de sa fenêtre (ombre, rebond). */
        private const val SIZE_DP = 60
        private const val MARGIN_DP = 10
        /** L'écart au bord de l'écran, une fois rangée. */
        private const val EDGE_DP = 6

        /** Se réduire en bulle en quittant l'application : activé par défaut,
         * réglé dans l'onglet Réglages (`BubblePlugin.auto`). */
        fun autoEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(AUTO, true)

        fun setAutoEnabled(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(AUTO, enabled).apply()
        }

        /** Montre la bulle (le service au premier plan). Appelé tant que
         * l'activité est encore au premier plan : Android 12+ refuse de
         * lancer un service au premier plan depuis l'arrière-plan. */
        fun start(context: Context, collapse: Boolean = false) {
            val intent = Intent(context, BubbleService::class.java).putExtra(EXTRA_LOCKED, locked).putExtra(EXTRA_COLLAPSE, collapse)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (e: Exception) {
                // Refusé par le système : pas de bulle cette fois.
            }
        }

        /** Les bords de l'écran entier, en px. */
        fun screen(context: Context): Rect {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Rect(wm.currentWindowMetrics.bounds)
            } else {
                val m = context.resources.displayMetrics
                Rect(0, 0, m.widthPixels, m.heightPixels)
            }
        }

        /** Où la bulle se posera (coin haut-gauche de sa fenêtre, px) : là où
         * on l'a laissée, sinon à droite, au tiers de la hauteur. */
        fun restingSpot(context: Context): Pair<Int, Int> {
            val d = context.resources.displayMetrics.density
            val win = ((SIZE_DP + 2 * MARGIN_DP) * d).toInt()
            val s = screen(context)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val right = prefs.getString(SIDE, "right") != "left"
            val edge = ((EDGE_DP - MARGIN_DP) * d).toInt()
            val x = if (right) s.width() - win - edge else edge
            val y = prefs.getInt(Y, s.height() / 3).coerceIn((48 * d).toInt(), s.height() - win - (96 * d).toInt())
            return x to y
        }
    }

    private lateinit var windows: WindowManager
    /** La fenêtre de la bulle, et la bulle dedans (plus petite : de la place
     * pour l'ombre et le rebond). */
    private var frame: FrameLayout? = null
    private var bubble: ImageView? = null
    private var target: FrameLayout? = null
    private var targetCircle: View? = null
    private var targetShown = false
    private lateinit var params: WindowManager.LayoutParams
    private var springX: SpringAnimation? = null
    private var springY: SpringAnimation? = null
    private var saturation = 1f
    private var leaving = false
    /** L'image qui grandit ou rétrécit entre la bulle et le plein écran. */
    private var morph: MorphView? = null
    /** La bulle a rouvert GuiVault, dont la fenêtre n'est pas encore là. */
    private var opening = false

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun dpf(v: Float) = v * resources.displayMetrics.density

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        current = this
        windows = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let { locked = it.getBooleanExtra(EXTRA_LOCKED, locked) }
        val collapse = intent?.getBooleanExtra(EXTRA_COLLAPSE, false) == true
        goForeground()
        if (frame == null) addBubble(pop = !collapse) else paint(animate = false)
        if (collapse) collapseFromApp()
        return START_NOT_STICKY
    }

    /** L'application balayée des récentes : la bulle s'en va avec elle. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        springX?.cancel()
        springY?.cancel()
        frame?.let { runCatching { windows.removeView(it) } }
        target?.let { runCatching { windows.removeView(it) } }
        morph?.let { runCatching { windows.removeView(it) } }
        morph = null
        frame = null
        bubble = null
        target = null
        current = null
        super.onDestroy()
    }

    // ─── Le service au premier plan ─────────────────────────────────────────

    private fun goForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Bulle GuiVault", NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                },
            )
        }
        val open = PendingIntent.getActivity(this, 0, launchIntent(), PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this))
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("GuiVault est réduit en bulle")
            .setContentText("Touchez la bulle pour le rouvrir.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun launchIntent(): Intent =
        (packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)

    // ─── La bulle ───────────────────────────────────────────────────────────

    private fun overlayParams(w: Int, h: Int, touchable: Boolean = true) = WindowManager.LayoutParams(
        w,
        h,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT,
    )

    private fun force(stiffness: Float, damping: Float) = SpringForce().setStiffness(stiffness).setDampingRatio(damping)

    /** Un ressort sur une propriété de vue, vers `to` (la `SpringForce`
     * garde sa position finale : en remplacer une sans elle fait échouer
     * `start`). */
    private fun springOn(v: View, prop: DynamicAnimation.ViewProperty, to: Float, stiffness: Float, damping: Float) =
        SpringAnimation(v, prop, to).apply { spring.setStiffness(stiffness).setDampingRatio(damping) }

    private fun addBubble(pop: Boolean = true) {
        val win = dp(SIZE_DP + 2 * MARGIN_DP)
        val view = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher_round)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(dp(6), dp(6), dp(6), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#17181D"))
                setStroke(dp(1), Color.parseColor("#2A2C33"))
            }
            elevation = dpf(6f)
            contentDescription = "GuiVault"
        }
        val box = FrameLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            addView(view, FrameLayout.LayoutParams(dp(SIZE_DP), dp(SIZE_DP), Gravity.CENTER))
        }
        val (x, y) = restingSpot(this)
        val fromRight = x > screen(this).width() / 2
        params = overlayParams(win, win).apply {
            gravity = Gravity.TOP or Gravity.START
            // Elle arrive du bord, en rebondissant jusqu'à sa place — ou y est
            // déjà, si elle naît de l'application qui rétrécit.
            this.x = if (!pop) x else if (fromRight) x + dp(36) else x - dp(36)
            this.y = y
        }
        box.setOnTouchListener(Drag())
        addTarget()
        windows.addView(box, params)
        frame = box
        bubble = view
        saturation = if (locked) 0f else 1f
        paint(animate = false)
        view.alpha = 0f
        // Elle naîtra de l'application qui rétrécit (`collapseFromApp`).
        if (!pop) return
        view.scaleX = 0f
        view.scaleY = 0f
        springOn(view, DynamicAnimation.SCALE_X, 1f, 380f, 0.55f).setStartVelocity(2f).start()
        springOn(view, DynamicAnimation.SCALE_Y, 1f, 380f, 0.55f).setStartVelocity(2f).start()
        springOn(view, DynamicAnimation.ALPHA, if (locked) 0.88f else 1f, 600f, 1f).start()
        moveTo(x.toFloat(), y.toFloat(), 0f, 0f, force(260f, 0.62f))
    }

    /** La fenêtre glisse jusqu'à (x, y) sur un ressort, en partant de la
     * vitesse du doigt (px/s). */
    private fun moveTo(x: Float, y: Float, vx: Float, vy: Float, force: SpringForce) {
        springX?.cancel()
        springY?.cancel()
        springX = SpringAnimation(FloatValueHolder(params.x.toFloat())).apply {
            spring = SpringForce(x).setStiffness(force.stiffness).setDampingRatio(force.dampingRatio)
            setStartVelocity(vx)
            addUpdateListener { _, v, _ -> params.x = v.toInt(); relayout() }
            start()
        }
        springY = SpringAnimation(FloatValueHolder(params.y.toFloat())).apply {
            spring = SpringForce(y).setStiffness(force.stiffness).setDampingRatio(force.dampingRatio)
            setStartVelocity(vy)
            addUpdateListener { _, v, _ -> params.y = v.toInt(); relayout() }
            start()
        }
    }

    private fun relayout() {
        frame?.let { if (it.isAttachedToWindow) windows.updateViewLayout(it, params) }
    }

    /** Le logo, en couleur ou en gris (verrouillé) — en fondu si l'état
     * change sous les yeux. */
    fun paint(animate: Boolean) {
        val view = bubble ?: return
        val to = if (locked) 0f else 1f
        val apply = { s: Float ->
            saturation = s
            view.colorFilter = if (s >= 1f) null else ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(s) })
            view.alpha = 0.88f + 0.12f * s
        }
        if (!animate) {
            apply(to)
            return
        }
        ValueAnimator.ofFloat(saturation, to).apply {
            duration = 320
            addUpdateListener { apply(it.animatedValue as Float) }
            start()
        }
    }

    // ─── La croix du bas ────────────────────────────────────────────────────

    /** Un voile en bas de l'écran, et la croix qui monte dedans. Sa fenêtre
     * est posée (invisible) avant celle de la bulle : la bulle reste
     * par-dessus quand l'aimant l'attire. */
    private fun addTarget() {
        val height = dp(220)
        val circle = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#E617181D"))
                setStroke(dp(2), Color.parseColor("#F05252"))
            }
            addView(TextView(this@BubbleService).apply {
                text = "✕"
                textSize = 22f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
            }, FrameLayout.LayoutParams(dp(64), dp(64)))
            translationY = dpf(60f)
        }
        val view = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.parseColor("#99000000"), Color.TRANSPARENT))
            clipChildren = false
            addView(circle, FrameLayout.LayoutParams(dp(64), dp(64), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(72) })
            alpha = 0f
        }
        val p = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, height, touchable = false).apply {
            gravity = Gravity.BOTTOM or Gravity.START
        }
        windows.addView(view, p)
        target = view
        targetCircle = circle
    }

    private fun showTarget() {
        val view = target ?: return
        val circle = targetCircle ?: return
        if (targetShown) return
        targetShown = true
        view.animate().cancel()
        view.animate().alpha(1f).setStartDelay(0).setDuration(180).start()
        circle.animate().cancel()
        circle.scaleX = 1f
        circle.scaleY = 1f
        springOn(circle, DynamicAnimation.TRANSLATION_Y, 0f, 500f, 0.7f).start()
    }

    private fun hideTarget(after: Long = 0) {
        val view = target ?: return
        if (!targetShown) return
        targetShown = false
        targetCircle?.animate()?.translationY(dpf(60f))?.setStartDelay(after)?.setDuration(200)?.start()
        view.animate().alpha(0f).setStartDelay(after).setDuration(200).start()
    }

    /** Le centre de la croix, et celui de la bulle, sur l'écran. */
    private fun centerOf(v: View): Pair<Float, Float> {
        val at = IntArray(2)
        v.getLocationOnScreen(at)
        return at[0] + v.width / 2f to at[1] + v.height / 2f
    }

    // ─── Les gestes ─────────────────────────────────────────────────────────

    private inner class Drag : View.OnTouchListener {
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var moved = false
        private var magnet = false
        private var velocity: VelocityTracker? = null

        /** La vitesse se mesure à l'écran : la fenêtre suit le doigt, les
         * coordonnées relatives à elle ne bougent presque pas. */
        private fun track(e: MotionEvent) {
            val c = MotionEvent.obtain(e)
            c.setLocation(e.rawX, e.rawY)
            velocity?.addMovement(c)
            c.recycle()
        }

        private fun press(down: Boolean) {
            val v = bubble ?: return
            val s = if (down) 0.9f else 1f
            springOn(v, DynamicAnimation.SCALE_X, s, 800f, 0.6f).start()
            springOn(v, DynamicAnimation.SCALE_Y, s, 800f, 0.6f).start()
        }

        override fun onTouch(v: View, e: MotionEvent): Boolean {
            if (leaving) return true
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    springX?.cancel()
                    springY?.cancel()
                    startX = params.x
                    startY = params.y
                    touchX = e.rawX
                    touchY = e.rawY
                    moved = false
                    magnet = false
                    velocity?.recycle()
                    velocity = VelocityTracker.obtain()
                    track(e)
                    press(true)
                }
                MotionEvent.ACTION_MOVE -> {
                    track(e)
                    val dx = e.rawX - touchX
                    val dy = e.rawY - touchY
                    if (!moved && (abs(dx) > dp(6) || abs(dy) > dp(6))) {
                        moved = true
                        press(false)
                        showTarget()
                    }
                    if (!moved) return true
                    val circle = targetCircle
                    val near = circle != null && targetShown && run {
                        val (tx, ty) = centerOf(circle)
                        hypot(e.rawX - tx, e.rawY - ty) < dp(96)
                    }
                    if (near && circle != null) {
                        if (!magnet) {
                            // L'aimant : la bulle saute sur la croix, qui grossit.
                            magnet = true
                            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                            circle.animate().scaleX(1.22f).scaleY(1.22f).setDuration(160).start()
                            val (tx, ty) = centerOf(circle)
                            val (bx, by) = centerOf(v)
                            moveTo(params.x + (tx - bx), params.y + (ty - by), 0f, 0f, force(900f, 0.7f))
                        }
                    } else {
                        if (magnet) {
                            magnet = false
                            circle?.animate()?.scaleX(1f)?.scaleY(1f)?.setDuration(160)?.start()
                            springX?.cancel()
                            springY?.cancel()
                        }
                        params.x = startX + dx.toInt()
                        params.y = startY + dy.toInt()
                        relayout()
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    track(e)
                    velocity?.computeCurrentVelocity(1000)
                    val vx = velocity?.xVelocity ?: 0f
                    val vy = velocity?.yVelocity ?: 0f
                    velocity?.recycle()
                    velocity = null
                    if (!moved) {
                        press(false)
                        if (e.actionMasked == MotionEvent.ACTION_UP) open()
                        return true
                    }
                    if (magnet) dismiss() else fling(vx, vy)
                }
            }
            return true
        }
    }

    /** Lâchée : vers le bord que désigne le geste (ou le plus proche), à la
     * hauteur où l'élan la porte. */
    private fun fling(vx: Float, vy: Float) {
        hideTarget()
        val s = screen(this)
        val win = dp(SIZE_DP + 2 * MARGIN_DP)
        val center = params.x + win / 2
        val right = if (abs(vx) > dp(500)) vx > 0 else center > s.width() / 2
        val edge = dp(EDGE_DP - MARGIN_DP)
        val x = if (right) s.width() - win - edge else edge
        val y = (params.y + vy * 0.16f).coerceIn(dpf(48f), (s.height() - win - dp(96)).toFloat())
        moveTo(x.toFloat(), y, vx, vy, force(220f, 0.68f))
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(SIDE, if (right) "right" else "left")
            .putInt(Y, y.toInt())
            .apply()
    }

    /** Sur la croix : la bulle s'y engouffre, puis tout s'en va. */
    private fun dismiss() {
        leaving = true
        val v = bubble ?: return stopSelf()
        frame?.performHapticFeedback(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS)
        targetCircle?.animate()?.scaleX(0.6f)?.scaleY(0.6f)?.setDuration(200)?.setInterpolator(PathInterpolator(0.4f, 0f, 1f, 1f))?.start()
        hideTarget(after = 140)
        v.animate().scaleX(0f).scaleY(0f).alpha(0f).setDuration(220)
            .setInterpolator(PathInterpolator(0.4f, 0f, 1f, 1f))
            .withEndAction { stopSelf() }
            .start()
    }

    // ─── Entre la bulle et le plein écran ───────────────────────────────────

    /** La bulle sur l'écran (px). */
    private fun bubbleRect(): RectF {
        val m = dp(MARGIN_DP).toFloat()
        val size = dp(SIZE_DP).toFloat()
        return RectF(params.x + m, params.y + m, params.x + m + size, params.y + m + size)
    }

    /** La fenêtre de l'image : tout l'écran. Elle prend les touchers le temps
     * de l'animation — une superposition qui les laisse passer, Android la
     * rend translucide (au plus 0,8 d'opacité, Android 12+). Capturable comme
     * la fenêtre de GuiVault elle-même (le jour où elle prend `FLAG_SECURE`,
     * l'image le prend aussi). */
    private fun addMorph(p: Float): MorphView {
        morph?.let { runCatching { windows.removeView(it) } }
        val s = screen(this)
        val full = RectF(0f, 0f, s.width().toFloat(), s.height().toFloat())
        val view = MorphView(snapshot, bubbleRect(), if (snapshot != null) RectF(snapshotAt) else full)
        view.p = p
        val lp = overlayParams(s.width(), s.height()).apply {
            gravity = Gravity.TOP or Gravity.START
        }
        windows.addView(view, lp)
        morph = view
        return view
    }

    private fun animateMorph(view: MorphView, to: Float, stiffness: Float, damping: Float, end: () -> Unit) {
        SpringAnimation(FloatValueHolder(view.p)).apply {
            spring = SpringForce(to).setStiffness(stiffness).setDampingRatio(damping)
            setMinimumVisibleChange(0.001f)
            addUpdateListener { _, v, _ -> view.p = v }
            addEndListener { _, canceled, _, _ -> if (!canceled) end() }
            start()
        }
    }

    /** Un toucher : l'image de GuiVault grandit depuis la bulle jusqu'au
     * plein écran, puis l'application revient dessous, sans animation du
     * système ; [finishOpen] efface l'image quand elle est là. */
    private fun open() {
        leaving = true
        opening = true
        val view = addMorph(0f)
        bubble?.alpha = 0f
        animateMorph(view, 1f, 300f, 0.86f) {
            val options = ActivityOptions.makeCustomAnimation(this, 0, 0).toBundle()
            try {
                startActivity(launchIntent(), options)
            } catch (e: Exception) {
                startActivity(launchIntent())
            }
            // L'application ne revient pas ? On ne reste pas couvert.
            view.postDelayed({ if (opening) finishOpen(null) }, 3000)
        }
    }

    /** La fenêtre de GuiVault est revenue : l'image s'efface sur elle — une
     * fois cette fenêtre dessinée et l'animation du système finie dessous
     * (`decor` : sa vue racine ; `null` : tout de suite). */
    fun finishOpen(decor: View?) {
        if (!opening) return
        opening = false
        val view = morph ?: return stopSelf()
        val fade = Runnable { view.animate().alpha(0f).setDuration(200).withEndAction { stopSelf() }.start() }
        if (decor == null) {
            fade.run()
            return
        }
        val observer = decor.viewTreeObserver
        observer.addOnDrawListener(object : ViewTreeObserver.OnDrawListener {
            private var seen = false

            override fun onDraw() {
                if (seen) return
                seen = true
                // Un écouteur ne se retire pas pendant le dessin.
                decor.post { if (observer.isAlive) observer.removeOnDrawListener(this) }
                view.postDelayed(fade, 350)
            }
        })
        decor.invalidate()
    }

    /** « Réduire en bulle » : l'image couvre l'écran, GuiVault passe
     * derrière, puis l'image rétrécit jusqu'à la bulle, qui prend le relais. */
    private fun collapseFromApp() {
        val goBack = afterCover
        afterCover = null
        if (snapshot == null) {
            goBack?.invoke()
            revealBubble()
            return
        }
        leaving = true
        val view = addMorph(1f)
        view.post {
            goBack?.invoke()
            view.postDelayed({
                animateMorph(view, 0f, 240f, 0.9f) {
                    revealBubble()
                    morph = null
                    runCatching { windows.removeView(view) }
                    leaving = false
                }
            }, 70)
        }
    }

    /** La bulle apparaît là où l'image s'est posée. */
    private fun revealBubble() {
        val v = bubble ?: return
        v.scaleX = 0.92f
        v.scaleY = 0.92f
        v.alpha = if (locked) 0.88f else 1f
        springOn(v, DynamicAnimation.SCALE_X, 1f, 600f, 0.5f).start()
        springOn(v, DynamicAnimation.SCALE_Y, 1f, 600f, 0.5f).start()
    }

    /** L'image entre la bulle (`p` = 0, un disque avec le logo) et sa place
     * en plein écran (`p` = 1), recadrée sans déformation ; l'application
     * de derrière s'assombrit à mesure. */
    private inner class MorphView(private val snap: Bitmap?, private val from: RectF, private val to: RectF) : View(this@BubbleService) {
        var p = 0f
            set(value) {
                field = value
                invalidate()
            }
        private val r = RectF()
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private val shader = snap?.let { BitmapShader(it, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
        private val fit = Matrix()
        private val dim = Paint().apply { color = Color.BLACK }
        private val backing = Paint(Paint.ANTI_ALIAS_FLAG)
        private val disk = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#17181D") }
        private val logo = getDrawable(R.mipmap.ic_launcher_round)?.mutate()?.apply {
            if (locked) colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) })
        }

        private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t

        override fun onDraw(c: Canvas) {
            val t = p
            val k = t.coerceIn(0f, 1f)
            dim.alpha = (k * 0.3f * 255).toInt()
            c.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dim)
            r.set(lerp(from.left, to.left, t), lerp(from.top, to.top, t), lerp(from.right, to.right, t), lerp(from.bottom, to.bottom, t))
            val radius = lerp(from.width() / 2f, 0f, k)
            if (snap != null && shader != null) {
                val s = max(r.width() / snap.width, r.height() / snap.height)
                fit.setScale(s, s)
                fit.postTranslate(r.centerX() - snap.width * s / 2f, r.centerY() - snap.height * s / 2f)
                shader.setLocalMatrix(fit)
                fill.shader = shader
            } else {
                fill.shader = null
                fill.color = backdrop
            }
            if (fill.shader != null) {
                // Sous l'image, le fond de l'application : rien ne transparaît.
                backing.color = backdrop
                c.drawRoundRect(r, radius, radius, backing)
            }
            c.drawRoundRect(r, radius, radius, fill)
            // Le logo de la bulle s'efface dans le premier tiers du trajet.
            val a = (1f - k / 0.35f).coerceIn(0f, 1f)
            if (a > 0f) {
                disk.alpha = (a * 255).toInt()
                c.drawRoundRect(r, radius, radius, disk)
                logo?.let {
                    val side = min(r.width(), r.height()) * 0.8f
                    it.setBounds((r.centerX() - side / 2).toInt(), (r.centerY() - side / 2).toInt(), (r.centerX() + side / 2).toInt(), (r.centerY() + side / 2).toInt())
                    it.alpha = (a * 255).toInt()
                    it.draw(c)
                }
            }
        }
    }
}
