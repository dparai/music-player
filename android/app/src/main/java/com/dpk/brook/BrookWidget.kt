package com.dpk.brook

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.util.SizeF
import android.view.KeyEvent
import android.widget.RemoteViews
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaButtonReceiver

/**
 * The home-screen widget, styled like the Brook app: the dark purple gradient, a rounded cover, white title,
 * dim artist and the round accent play button. It resizes in both directions and picks a layout to fit:
 * a tile (cover and play), one row, the default player, and a tall player with a big cover. The buttons are
 * ordinary media-button presses, so they work even when Android has killed the app (the press starts the player
 * service and resumes the last queue). The player service keeps the widget current as songs change.
 */
@UnstableApi
class BrookWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val views = WidgetState.views(context)
        ids.forEach { manager.updateAppWidget(it, views) }
    }

    companion object {
        /** Show the title, artist and cover, and the right play-pause icon, on every Brook widget. */
        fun update(context: Context, title: String?, artist: String?, playing: Boolean, art: Bitmap?) {
            WidgetState.save(context, title, artist, playing)
            WidgetState.art = art?.let { WidgetState.rounded(it) }
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, BrookWidget::class.java))
            if (ids.isEmpty()) return
            val views = WidgetState.views(context)
            ids.forEach { manager.updateAppWidget(it, views) }
        }
    }
}

@UnstableApi
object WidgetState {
    @Volatile var art: Bitmap? = null
    private var logo: Bitmap? = null

    fun save(context: Context, title: String?, artist: String?, playing: Boolean) {
        context.getSharedPreferences("widget", Context.MODE_PRIVATE).edit()
            .putString("title", title).putString("artist", artist).putBoolean("playing", playing).apply()
    }

    /** The cover with softly rounded corners, like the cover in the app (a widget cannot clip an image itself). */
    fun rounded(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        val r = src.width * 0.18f
        Canvas(out).drawRoundRect(RectF(0f, 0f, src.width.toFloat(), src.height.toFloat()), r, r, paint)
        return out
    }

    // Until a song brings its own cover, the Brook logo stands in.
    private fun cover(context: Context): Bitmap? {
        art?.let { return it }
        logo?.let { return it }
        val l = BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher)?.let { rounded(it) }
        logo = l
        return l
    }

    private fun mediaKey(context: Context, code: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_MEDIA_BUTTON)
            .setComponent(ComponentName(context, MediaButtonReceiver::class.java))
            .putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, code))
        return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun fill(context: Context, layout: Int): RemoteViews {
        val prefs = context.getSharedPreferences("widget", Context.MODE_PRIVATE)
        val title = prefs.getString("title", null)
        val playing = prefs.getBoolean("playing", false)
        val v = RemoteViews(context.packageName, layout)
        v.setTextViewText(R.id.widget_title, title ?: context.getString(R.string.app_name))
        v.setTextViewText(
            R.id.widget_artist,
            if (title == null) context.getString(R.string.widget_idle) else prefs.getString("artist", "") ?: "",
        )
        cover(context)?.let { v.setImageViewBitmap(R.id.widget_art, it) }
        v.setImageViewResource(R.id.widget_play, if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play)
        v.setContentDescription(R.id.widget_play, context.getString(if (playing) R.string.widget_pause else R.string.widget_play))
        v.setOnClickPendingIntent(R.id.widget_prev, mediaKey(context, KeyEvent.KEYCODE_MEDIA_PREVIOUS))
        v.setOnClickPendingIntent(R.id.widget_play, mediaKey(context, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        v.setOnClickPendingIntent(R.id.widget_next, mediaKey(context, KeyEvent.KEYCODE_MEDIA_NEXT))
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        v.setOnClickPendingIntent(R.id.widget_root, open)
        v.setOnClickPendingIntent(R.id.widget_art, open)
        v.setOnClickPendingIntent(R.id.widget_title, open)
        return v
    }

    /** The widget for its current size: Android 12 and later picks one of four layouts as it is resized. */
    fun views(context: Context): RemoteViews {
        if (Build.VERSION.SDK_INT < 31) return fill(context, R.layout.widget_brook)
        return RemoteViews(
            mapOf(
                SizeF(110f, 40f) to fill(context, R.layout.widget_small),    // tile: cover and play
                SizeF(220f, 48f) to fill(context, R.layout.widget_medium),   // one row
                SizeF(220f, 100f) to fill(context, R.layout.widget_brook),   // the default player
                SizeF(220f, 190f) to fill(context, R.layout.widget_xl),      // tall, with a big cover
            ),
        )
    }
}
