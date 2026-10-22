package dev.guivault.client

import android.animation.ValueAnimator
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
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot

/**
 * La bulle elle-même : une fenêtre de superposition (`TYPE_APPLICATION_OVERLAY`)
 * tenue par un service au premier plan, comme les « chat heads » de
 * Messenger. On la déplace du doigt, elle se range contre le bord le plus
 * proche ; un toucher rouvre GuiVault ; la glisser sur la croix du bas la
 * ferme. Elle ne montre que le logo — gris quand le coffre est verrouillé.
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
            locked = value
            current?.let { s -> s.bubble?.post { s.paint() } }
        }
    }

    private lateinit var windows: WindowManager
    private var bubble: ImageView? = null
    private var target: View? = null
    private lateinit var params: WindowManager.LayoutParams

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        current = this
        windows = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let { locked = it.getBooleanExtra(EXTRA_LOCKED, locked) }
        goForeground()
        if (bubble == null) addBubble() else paint()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        bubble?.let { windows.removeView(it) }
        target?.let { windows.removeView(it) }
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

    private fun overlayParams(w: Int, h: Int) = WindowManager.LayoutParams(
        w,
        h,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

    private fun addBubble() {
        val size = dp(60)
        val view = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher_round)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(dp(6), dp(6), dp(6), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#17181D"))
                setStroke(dp(1), Color.parseColor("#2A2C33"))
            }
            elevation = dp(8).toFloat()
            contentDescription = "GuiVault"
        }
        params = overlayParams(size, size).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - size - dp(8)
            y = resources.displayMetrics.heightPixels / 3
        }
        view.setOnTouchListener(Drag())
        windows.addView(view, params)
        bubble = view
        paint()
    }

    /** Le logo, en couleur ou en gris (verrouillé). */
    fun paint() {
        val view = bubble ?: return
        view.colorFilter = if (locked) ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) }) else null
        view.alpha = if (locked) 0.85f else 1f
    }

    /** La croix du bas, pendant qu'on déplace la bulle. */
    private fun showTarget(show: Boolean) {
        if (show && target == null) {
            val size = dp(64)
            val view = FrameLayout(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#CC17181D"))
                    setStroke(dp(2), Color.parseColor("#F05252"))
                }
                addView(TextView(this@BubbleService).apply {
                    text = "✕"
                    textSize = 22f
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                }, FrameLayout.LayoutParams(size, size))
            }
            val p = overlayParams(size, size).apply {
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                y = dp(48)
            }
            windows.addView(view, p)
            target = view
        } else if (!show) {
            target?.let { windows.removeView(it) }
            target = null
        }
    }

    /** Le centre de la bulle est-il sur la croix ? */
    private fun overTarget(): Boolean {
        val m = resources.displayMetrics
        val size = dp(60)
        val cx = params.x + size / 2f
        val cy = params.y + size / 2f
        val tx = m.widthPixels / 2f
        val ty = m.heightPixels - dp(48) - dp(32).toFloat()
        return hypot(cx - tx, cy - ty) < dp(72)
    }

    private inner class Drag : View.OnTouchListener {
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var moved = false

        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = e.rawX
                    touchY = e.rawY
                    moved = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - touchX
                    val dy = e.rawY - touchY
                    if (!moved && (abs(dx) > dp(6) || abs(dy) > dp(6))) {
                        moved = true
                        showTarget(true)
                    }
                    if (moved) {
                        params.x = startX + dx.toInt()
                        params.y = startY + dy.toInt()
                        windows.updateViewLayout(v, params)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) {
                        // Un toucher : GuiVault revient (le plugin retire la
                        // bulle à la reprise).
                        startActivity(launchIntent())
                        stopSelf()
                        return true
                    }
                    val drop = overTarget()
                    showTarget(false)
                    if (drop) stopSelf() else snap(v)
                }
            }
            return true
        }
    }

    /** Contre le bord le plus proche, en glissant. */
    private fun snap(v: View) {
        val width = resources.displayMetrics.widthPixels
        val size = dp(60)
        val end = if (params.x + size / 2 < width / 2) dp(8) else width - size - dp(8)
        ValueAnimator.ofInt(params.x, end).apply {
            duration = 220
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                params.x = it.animatedValue as Int
                if (bubble != null) windows.updateViewLayout(v, params)
            }
            start()
        }
    }
}
