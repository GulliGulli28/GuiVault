package dev.guivault.client

import android.animation.ValueAnimator
import android.app.ActivityOptions
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
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

/**
 * La bulle elle-même : une fenêtre de superposition (`TYPE_APPLICATION_OVERLAY`)
 * tenue par un service au premier plan, comme les « chat heads » de
 * Messenger. Tout bouge sur des ressorts (`SpringAnimation`) : elle arrive en
 * rebondissant, se lance d'un geste vers un bord, se laisse aimanter par la
 * croix du bas qui la ferme ; un toucher rouvre GuiVault, qui s'agrandit
 * depuis elle. Elle retient sa place (bord et hauteur) d'une fois sur
 * l'autre. Elle ne montre que le logo — gris quand le coffre est verrouillé.
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
            if (changed) current?.let { s -> s.bubble?.post { s.paint(animate = true) } }
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
        fun start(context: Context) {
            val intent = Intent(context, BubbleService::class.java).putExtra(EXTRA_LOCKED, locked)
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

        /** Le centre de la bulle à venir, en px CSS (la WebView couvre tout
         * l'écran) : l'interface y fait converger son animation. */
        fun anchor(context: Context): Pair<Float, Float> {
            val d = context.resources.displayMetrics.density
            val half = (SIZE_DP / 2 + MARGIN_DP) * d
            val (x, y) = restingSpot(context)
            return (x + half) / d to (y + half) / d
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
        goForeground()
        if (frame == null) addBubble() else paint(animate = false)
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

    private fun addBubble() {
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
            // Elle arrive du bord, en rebondissant jusqu'à sa place.
            this.x = if (fromRight) x + dp(36) else x - dp(36)
            this.y = y
        }
        box.setOnTouchListener(Drag())
        addTarget()
        windows.addView(box, params)
        frame = box
        bubble = view
        saturation = if (locked) 0f else 1f
        paint(animate = false)
        view.scaleX = 0f
        view.scaleY = 0f
        view.alpha = 0f
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

    /** Un toucher : GuiVault revient en grandissant depuis la bulle, qui
     * s'efface dans le même mouvement (le plugin retire le service à la
     * reprise). */
    private fun open() {
        leaving = true
        val v = bubble
        val options = v?.let { ActivityOptions.makeScaleUpAnimation(it, 0, 0, it.width, it.height).toBundle() }
        try {
            startActivity(launchIntent(), options)
        } catch (e: Exception) {
            startActivity(launchIntent())
        }
        if (v == null) return stopSelf()
        v.animate().scaleX(1.25f).scaleY(1.25f).alpha(0f).setDuration(200)
            .setInterpolator(PathInterpolator(0.2f, 0f, 0f, 1f))
            .withEndAction { stopSelf() }
            .start()
    }
}
