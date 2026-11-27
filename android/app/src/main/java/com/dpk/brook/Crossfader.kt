package com.dpk.brook

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Overlaps the end of one song with the start of the next. Two players take turns: while the first plays
 * out, the second is loaded with the same queue at the next song and started silently; their volumes then
 * cross on equal-power curves, and the second becomes the player the media session (lock screen,
 * notification, headset) talks to. It all happens here, in the service, so it works with the screen off.
 *
 * Without a plan for the pair of songs it is a plain fade of [fadeMs] ending as the song ends. A plan
 * (made by the web UI from the server's beat data, so only when online) says where to start in each
 * song and how long to mix, and the incoming song may be sped up or slowed to the outgoing tempo.
 */
@UnstableApi
class Crossfader(
    first: ExoPlayer,
    second: ExoPlayer,
    private val attrs: AudioAttributes,
    private val onSwap: (ExoPlayer) -> Unit,
) {
    data class Plan(
        val fromId: String,
        val toId: String,
        val cueOutMs: Long,   // position in the outgoing song where the mix starts
        val inStartMs: Long,  // position in the incoming song it starts from
        val fadeMs: Long,
        val rate: Float,      // incoming speed (1 = as recorded)
    )

    var primary: ExoPlayer = first
        private set
    private var secondary: ExoPlayer = second

    @Volatile var enabled = false
    @Volatile var debug = false // test builds: log the volumes through a mix
    private var steps = 0
    @Volatile var fadeMs = DEFAULT_FADE_MS
    /** "start" / "end" / "abort", whether the mix used a plan, and its length. */
    var listener: ((String, Boolean, Long) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val plans = HashMap<String, Plan>()

    private enum class Phase { IDLE, LOADING, FADING }
    private var phase = Phase.IDLE
    private var plan: Plan? = null
    private var fadeLen = 0L
    private var fadeBegin = 0L
    private var pausedAt = 0L
    private var loadingSince = 0L
    private var cueMs = 0L

    private val tick = object : Runnable {
        override fun run() {
            try { step() } catch (e: Exception) { Log.w(TAG, "crossfade step failed: ${e.message}"); abort() }
            main.postDelayed(this, if (phase == Phase.FADING) FADE_STEP_MS else IDLE_STEP_MS)
        }
    }

    fun start() {
        main.removeCallbacks(tick)
        main.post(tick)
    }

    fun stop() {
        main.removeCallbacks(tick)
        abort()
    }

    fun setPlan(p: Plan) {
        plans["${p.fromId}>${p.toId}"] = p
        if (plans.size > MAX_PLANS) plans.remove(plans.keys.first())
    }

    fun clearPlans() = plans.clear()

    val busy: Boolean get() = phase != Phase.IDLE

    // --- what the service tells us about the primary player ----------------------------------------------

    /** The user (or the web UI) changed the queue or position while a mix was under way: drop the mix. */
    fun primaryChangedUnderneath() {
        if (phase != Phase.IDLE) abort()
    }

    fun secondaryFailed() {
        if (phase != Phase.IDLE) abort()
    }

    // --- the mix -------------------------------------------------------------------------------------------

    private fun key(cur: MediaItem, next: MediaItem) = "${cur.mediaId}>${next.mediaId}"

    private fun step() {
        when (phase) {
            Phase.IDLE -> maybeLoad()
            Phase.LOADING -> maybeBegin()
            Phase.FADING -> fade()
        }
    }

    private fun maybeLoad() {
        if (!enabled) return
        val p = primary
        if (!p.isPlaying || SleepTimer.endOfSong) return
        val cur = p.currentMediaItem ?: return
        val ni = p.nextMediaItemIndex
        if (ni == C.INDEX_UNSET || ni == p.currentMediaItemIndex) return
        val next = p.getMediaItemAt(ni)
        if (next.mediaId == cur.mediaId) return
        val dur = p.duration
        if (dur == C.TIME_UNSET || dur < MIN_SONG_MS) return

        val pl = plans[key(cur, next)]
        val len = min(pl?.fadeMs ?: fadeMs, dur / 3)
        val cue = (pl?.cueOutMs ?: (dur - len)).coerceAtLeast(0)
        val pos = p.currentPosition
        if (pos < cue - LOAD_LEAD_MS) return        // not time to load the next song yet
        if (pos >= dur - MIN_FADE_MS) return        // too late: the song is about to end by itself

        val s = secondary
        phase = Phase.LOADING
        plan = pl
        fadeLen = min(len, dur - maxOf(pos, cue) - 100).coerceAtLeast(MIN_FADE_MS)
        cueMs = cue
        loadingSince = SystemClock.elapsedRealtime()
        val items = ArrayList<MediaItem>(p.mediaItemCount)
        for (i in 0 until p.mediaItemCount) items.add(p.getMediaItemAt(i))
        s.volume = 0f
        s.setMediaItems(items, ni, pl?.inStartMs ?: 0L)
        s.playbackParameters = PlaybackParameters(pl?.rate ?: 1f, 1f)
        s.playWhenReady = false
        s.prepare()
        Log.i(TAG, "crossfade: loading ${next.mediaId} (plan=${pl != null}, fade=${fadeLen}ms, cue=${cue}ms)")
    }

    private fun maybeBegin() {
        val p = primary
        val s = secondary
        if (!p.isPlaying && !p.playWhenReady) { abort(); return }
        if (SystemClock.elapsedRealtime() - loadingSince > LOAD_TIMEOUT_MS) {
            Log.w(TAG, "crossfade: the next song did not load in time, playing it normally")
            abort(); return
        }
        if (s.playbackState != Player.STATE_READY) return
        val pos = p.currentPosition
        // The next song starts on the cue, a moment early to cover the audio output's start-up.
        if (pos < cueMs - START_LATENCY_MS) return
        s.play()
        fadeBegin = SystemClock.elapsedRealtime()
        pausedAt = 0L
        phase = Phase.FADING
        listener?.invoke("start", plan != null, fadeLen)
        Log.i(TAG, "crossfade: start at ${pos}ms of ${p.duration}ms")
    }

    private fun fade() {
        val p = primary
        val s = secondary
        val now = SystemClock.elapsedRealtime()
        if (!p.playWhenReady) {
            // Paused during the mix: hold both and keep the clock still.
            if (pausedAt == 0L) { pausedAt = now; s.pause() }
            return
        }
        if (pausedAt != 0L) { fadeBegin += now - pausedAt; pausedAt = 0L; s.play() }
        val t = ((now - fadeBegin).toFloat() / fadeLen).coerceIn(0f, 1f)
        p.volume = cos(t * PI.toFloat() / 2f)
        s.volume = sin(t * PI.toFloat() / 2f)
        if (debug && steps++ % 25 == 0) Log.i(TAG, "crossfade: t=%.2f out=%.3f in=%.3f power=%.3f".format(t, p.volume, s.volume, p.volume * p.volume + s.volume * s.volume))
        if (t >= 1f) finish()
    }

    private fun finish() {
        val p = primary
        val s = secondary
        val rate = plan?.rate ?: 1f
        s.volume = 1f
        // Audio focus passes to the new player before the session switches to it.
        s.setAudioAttributes(attrs, true)
        p.setAudioAttributes(attrs, false)
        onSwap(s)
        p.pause()
        p.stop()
        p.clearMediaItems()
        p.volume = 1f
        primary = s
        secondary = p
        phase = Phase.IDLE
        plan = null
        if (rate != 1f) easeSpeed(s, rate)
        listener?.invoke("end", rate != 1f, fadeLen)
        Log.i(TAG, "crossfade: done, now playing ${s.currentMediaItem?.mediaId}")
    }

    private fun abort() {
        if (phase == Phase.IDLE) return
        val p = primary
        val s = secondary
        s.pause()
        s.stop()
        s.clearMediaItems()
        s.volume = 0f
        p.volume = 1f
        phase = Phase.IDLE
        plan = null
        listener?.invoke("abort", false, 0)
        Log.i(TAG, "crossfade: cancelled")
    }

    // A song that was sped up or slowed to match the tempo eases back to its own speed instead of jumping.
    private fun easeSpeed(player: ExoPlayer, from: Float) {
        val steps = 20
        var i = 0
        val r = object : Runnable {
            override fun run() {
                i++
                val sp = from + (1f - from) * (i.toFloat() / steps)
                player.playbackParameters = PlaybackParameters(sp, 1f)
                if (i < steps && player === primary) main.postDelayed(this, 150)
            }
        }
        main.postDelayed(r, 150)
    }

    companion object {
        private const val TAG = "BrookPlayer"
        const val DEFAULT_FADE_MS = 6_000L
        private const val MIN_SONG_MS = 15_000L
        private const val MIN_FADE_MS = 1_000L
        private const val LOAD_LEAD_MS = 4_000L        // load the next song this long before the cue
        private const val LOAD_TIMEOUT_MS = 9_000L
        private const val START_LATENCY_MS = 90L
        private const val FADE_STEP_MS = 40L
        private const val IDLE_STEP_MS = 250L
        private const val MAX_PLANS = 40
    }
}
