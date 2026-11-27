package com.dpk.brook

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Plays Brook's songs. Android keeps a started media-playback service alive with the
 * screen off, and the lock screen, notification, headset and Bluetooth buttons all talk
 * to the MediaSession below, so none of it depends on the web page being awake.
 *
 * There are two identical players. Only one is the session's player at a time; the other waits
 * and is used by the [Crossfader] to overlap two songs.
 */
@UnstableApi
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val main = Handler(Looper.getMainLooper())
    private var retries = 0
    private val prefetcher = Prefetcher()
    private lateinit var store: QueueStore
    private lateinit var crossfader: Crossfader
    private var players: List<ExoPlayer> = emptyList()

    private val attrs = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build()

    private val saveTick = object : Runnable {
        override fun run() {
            session?.player?.let { if (it.isPlaying) store.save(it) }
            main.postDelayed(this, 15_000)
        }
    }

    private fun isPrimary(p: Player) = session?.player === p

    // The equaliser sits in the audio sink, so every song goes through it, gapless transitions included.
    private fun buildPlayer(eq: EqProcessor, handleFocus: Boolean): ExoPlayer {
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(
                context: Context,
                enableFloatOutput: Boolean,
                enableAudioTrackPlaybackParams: Boolean,
            ): AudioSink =
                DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioProcessors(arrayOf(eq))
                    .build()
        }
        val player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(BrookMedia.playbackFactory))
            .setAudioAttributes(attrs, handleFocus) // pause for a call, duck for navigation voice
            .setHandleAudioBecomingNoisy(true)      // pause when headphones are unplugged
            .setWakeMode(C.WAKE_MODE_NETWORK)       // keep CPU and Wi-Fi awake while playing with the screen off
            .build()
        // The web page refills the queue while it is alive; with the app swiped away nobody does, so the
        // queue loops at its end (as the web player does) instead of falling silent.
        player.repeatMode = Player.REPEAT_MODE_ALL
        player.addListener(Listener(player, eq))
        return player
    }

    private inner class Listener(private val player: ExoPlayer, private val eq: EqProcessor) : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "player error ${error.errorCodeName}: ${error.message} (${eq.label}${if (isPrimary(player)) " primary" else " idle/next"}, id=${player.currentMediaItem?.mediaId} idx=${player.currentMediaItemIndex} pos=${player.currentPosition} state=${player.playbackState})")
            if (!isPrimary(player)) { crossfader.secondaryFailed(); return }
            recover(player, error)
        }

        override fun onPlaybackStateChanged(state: Int) {
            // The player a song is coming in on is "secondary" until the mix finishes: log it too.
            Log.i(TAG, "state=$state playWhenReady=${player.playWhenReady} id=${player.currentMediaItem?.mediaId}${if (isPrimary(player)) "" else " (next)"}")
            if (state == Player.STATE_READY && isPrimary(player)) retries = 0
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (isPrimary(player)) Log.i(TAG, "playWhenReady=$playWhenReady reason=$reason")
        }

        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            // The loudness trim of the song that is now playing on this player.
            eq.setItemGainDb(item?.mediaMetadata?.extras?.getDouble("gainDb", 0.0) ?: 0.0)
            if (!isPrimary(player)) return
            Log.i(TAG, "transition id=${item?.mediaId} reason=$reason index=${player.currentMediaItemIndex}/${player.mediaItemCount}")
            retries = 0
            // A skip, a new queue or a song that ended by itself while a mix was loading: the mix no longer fits.
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) crossfader.primaryChangedUnderneath()
            schedulePrefetch(player)
            store.save(player)
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (isPrimary(player) && reason == Player.DISCONTINUITY_REASON_SEEK) crossfader.primaryChangedUnderneath()
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (!isPrimary(player)) return
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) crossfader.primaryChangedUnderneath()
            schedulePrefetch(player)
            store.save(player)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPrimary(player)) store.save(player) // a pause or a stop remembers where it was
        }
    }

    override fun onCreate() {
        super.onCreate()
        BrookMedia.init(this)
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        BrookMedia.eqs.forEach { it.meter = debuggable }
        store = QueueStore(this)

        val a = buildPlayer(BrookMedia.eqs[0], handleFocus = true)
        val b = buildPlayer(BrookMedia.eqs[1], handleFocus = false)
        players = listOf(a, b)
        BrookMedia.player = a

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, a)
            .setSessionActivity(open)
            .setCallback(object : MediaSession.Callback {
                // A headset / Bluetooth / lock-screen "play" with an empty player (the app was killed): bring the last queue back.
                override fun onPlaybackResumption(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
                    val saved = store.load()
                    Log.i(TAG, "resumption: ${saved?.mediaItems?.size ?: 0} saved songs")
                    return if (saved != null) Futures.immediateFuture(saved)
                    else Futures.immediateFailedFuture(UnsupportedOperationException("no saved queue"))
                }
            })
            .build()

        crossfader = Crossfader(a, b, attrs) { next ->
            session?.player = next
            BrookMedia.player = next
        }
        val prefs = getSharedPreferences("crossfade", Context.MODE_PRIVATE)
        crossfader.enabled = prefs.getBoolean("enabled", false)
        crossfader.fadeMs = prefs.getLong("fadeMs", Crossfader.DEFAULT_FADE_MS)
        crossfader.debug = debuggable
        BrookMedia.crossfader = crossfader
        crossfader.start()

        main.postDelayed(saveTick, 15_000)
    }

    // The songs after the current one, fetched into the phone's cache (see Prefetcher). Debounced: one queue
    // change arrives as several timeline events.
    private fun schedulePrefetch(player: ExoPlayer) {
        main.removeCallbacks(prefetchRunner)
        main.postDelayed(prefetchRunner, 600)
    }

    private val prefetchRunner = Runnable {
        val p = session?.player ?: return@Runnable
        val next = ArrayList<MediaItem>()
        var i = p.currentMediaItemIndex + 1
        while (i < p.mediaItemCount && next.size < PREFETCH_COUNT) {
            val item = p.getMediaItemAt(i)
            if (item.mediaMetadata.extras?.getBoolean("prefetch", false) == true) next.add(item)
            i++
        }
        prefetcher.fetch(next)
    }

    // A network problem retries the same song for as long as the player is meant to be playing, with a
    // growing delay (1.5 s up to 20 s), so a tunnel or a lift never ends the music. A song the server no
    // longer has (HTTP 4xx) or one that cannot be decoded is skipped, so one bad file never stops the rest.
    private fun recover(player: ExoPlayer, error: PlaybackException) {
        val http = error.cause as? HttpDataSource.InvalidResponseCodeException
        val gone = http != null && http.responseCode in 400..499
        val network = !gone && error.errorCode in listOf(
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
        )
        if (network) {
            retries++
            val delay = minOf(1500L shl minOf(retries - 1, 4), MAX_RETRY_DELAY_MS)
            Log.i(TAG, "retry $retries in ${delay}ms")
            main.postDelayed({
                if (player.playerError != null) player.prepare()
            }, delay)
        } else if (player.hasNextMediaItem()) {
            Log.i(TAG, "skipping the song that cannot play (${error.errorCodeName})")
            retries = 0
            player.seekToNextMediaItem()
            player.prepare()
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // Swiping the app away from recents must not stop the music; only an idle player stops the service.
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        prefetcher.cancel()
        SleepTimer.cancel()
        crossfader.stop()
        BrookMedia.crossfader = null
        BrookMedia.player = null
        session?.release()
        session = null
        players.forEach { it.release() }
        players = emptyList()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "BrookPlayer"
        private const val MAX_RETRY_DELAY_MS = 20_000L
        private const val PREFETCH_COUNT = 4
    }
}
