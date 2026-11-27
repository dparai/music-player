package com.dpk.brook

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

/**
 * Stops the music after a time, or at the end of the current song. Lives with the player, not the web
 * page, so it works with the screen off. The last [FADE_MS] before a timed stop fade the volume out.
 */
object SleepTimer {
    private const val FADE_MS = 8_000L
    private const val STEP_MS = 250L

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var deadline = 0L          // SystemClock.elapsedRealtime() at which the music stops
    private var fading = false

    @Volatile var endsAtEpochMs = 0L   // for the UI countdown
        private set
    @Volatile var endOfSong = false
        private set
    var onChange: (() -> Unit)? = null

    private val endListener = object : Player.Listener {
        // The player paused itself at the end of the song (pauseAtEndOfMediaItems): the timer is done.
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (endOfSong && !playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) cancel()
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            val p = BrookMedia.player ?: return
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) {
                p.pause()
                BrookMedia.setMasterGain(1.0)
                clear()
                return
            }
            if (left <= FADE_MS) {
                fading = true
                BrookMedia.setMasterGain((left.toDouble() / FADE_MS).coerceIn(0.0, 1.0))
            }
            main.postDelayed(this, if (left > FADE_MS + STEP_MS) minOf(left - FADE_MS, 1000L) else STEP_MS)
        }
    }

    fun start(p: ExoPlayer, minutes: Int, toEndOfSong: Boolean) {
        cancel()
        player = p
        if (toEndOfSong) {
            endOfSong = true
            p.pauseAtEndOfMediaItems = true
            p.addListener(endListener)
        } else if (minutes > 0) {
            deadline = SystemClock.elapsedRealtime() + minutes * 60_000L
            endsAtEpochMs = System.currentTimeMillis() + minutes * 60_000L
            main.post(tick)
        }
        onChange?.invoke()
    }

    fun cancel() {
        main.removeCallbacks(tick)
        player?.let {
            if (fading) BrookMedia.setMasterGain(1.0)
            if (endOfSong) { it.pauseAtEndOfMediaItems = false; it.removeListener(endListener) }
        }
        clear()
    }

    private fun clear() {
        fading = false
        endOfSong = false
        endsAtEpochMs = 0L
        deadline = 0L
        onChange?.invoke()
    }
}
