package com.dpk.brook

import android.app.PendingIntent
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Plays Brook's songs. Android keeps a started media-playback service alive with the
 * screen off, and the lock screen, notification, headset and Bluetooth buttons all talk
 * to the MediaSession below, so none of it depends on the web page being awake.
 */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val main = Handler(Looper.getMainLooper())
    private var retries = 0

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true, // pause for a call, duck for navigation voice
            )
            .setHandleAudioBecomingNoisy(true) // pause when headphones are unplugged
            .setWakeMode(C.WAKE_MODE_NETWORK)  // keep CPU and Wi-Fi awake while playing with the screen off
            .build()

        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "player error ${error.errorCodeName}: ${error.message}")
                recover(player, error)
            }

            override fun onPlaybackStateChanged(state: Int) {
                Log.i(TAG, "state=$state playWhenReady=${player.playWhenReady} id=${player.currentMediaItem?.mediaId}")
                if (state == Player.STATE_READY) retries = 0
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                Log.i(TAG, "playWhenReady=$playWhenReady reason=$reason")
            }

            override fun onMediaItemTransition(item: androidx.media3.common.MediaItem?, reason: Int) {
                Log.i(TAG, "transition id=${item?.mediaId} reason=$reason index=${player.currentMediaItemIndex}/${player.mediaItemCount}")
                retries = 0
            }
        })

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()
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
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "BrookPlayer"
        private const val MAX_RETRY_DELAY_MS = 20_000L
    }
}
