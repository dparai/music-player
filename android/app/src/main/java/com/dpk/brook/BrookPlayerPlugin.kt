package com.dpk.brook

import android.content.ComponentName
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import com.google.common.util.concurrent.ListenableFuture

/**
 * The web UI's handle on the player. It does not play anything itself: it is a
 * MediaController connected to [PlaybackService], like the lock screen is.
 */
@UnstableApi
@CapacitorPlugin(name = "BrookPlayer")
class BrookPlayerPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val waiting = ArrayList<(MediaController) -> Unit>()

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) = emitState()
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = emitState()
        override fun onIsPlayingChanged(isPlaying: Boolean) = emitState()

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val c = controller ?: return
            val o = JSObject()
            o.put("id", mediaItem?.mediaId)
            o.put("index", c.currentMediaItemIndex)
            o.put(
                "reason",
                when (reason) {
                    Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "auto"
                    Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "seek"
                    Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> "repeat"
                    else -> "playlist"
                },
            )
            notifyListeners("trackChanged", o)
            emitState()
        }

        override fun onPlayerError(error: PlaybackException) {
            val o = JSObject()
            o.put("message", error.message ?: error.errorCodeName)
            o.put("code", error.errorCode)
            o.put("id", controller?.currentMediaItem?.mediaId)
            notifyListeners("error", o)
        }
    }

    override fun load() {
        main.post {
            connect()
            BrookMedia.init(context)
            BrookMedia.downloadManager.addListener(downloadListener)
            SleepTimer.onChange = { notifyListeners("sleep", sleepObject()) }
            emitDownloads()
        }
    }

    // --- Sleep timer -------------------------------------------------------------------------------

    private fun sleepObject(): JSObject {
        val o = JSObject()
        o.put("endsAt", SleepTimer.endsAtEpochMs)
        o.put("endOfSong", SleepTimer.endOfSong)
        return o
    }

    @PluginMethod
    fun setSleepTimer(call: PluginCall) {
        val minutes = call.data.optInt("minutes", 0)
        val endOfSong = call.data.optBoolean("endOfSong", false)
        main.post {
            val p = BrookMedia.player
            if (p == null || (minutes <= 0 && !endOfSong)) SleepTimer.cancel() else SleepTimer.start(p, minutes, endOfSong)
            call.resolve(sleepObject())
        }
    }

    @PluginMethod
    fun getSleepTimer(call: PluginCall) {
        main.post { call.resolve(sleepObject()) }
    }

    // --- Downloads ---------------------------------------------------------------------------------

    private val downloadListener = object : DownloadManager.Listener {
        override fun onDownloadChanged(downloadManager: DownloadManager, download: Download, finalException: Exception?) = emitDownloads()
        override fun onDownloadRemoved(downloadManager: DownloadManager, download: Download) = emitDownloads()
        override fun onIdle(downloadManager: DownloadManager) = emitDownloads()
    }

    private val progressTick = object : Runnable {
        override fun run() {
            emitDownloads()
            if (BrookMedia.downloadManager.currentDownloads.isNotEmpty()) main.postDelayed(this, 1000)
        }
    }

    // Songs saved on the phone ("done") and the ones still on their way, as the web UI shows them.
    private fun downloadsObject(): JSObject {
        val done = JSArray()
        val active = JSObject()
        val cursor = BrookMedia.downloadManager.downloadIndex.getDownloads()
        try {
            while (cursor.moveToNext()) {
                val d = cursor.download
                val o = JSObject()
                when (d.state) {
                    Download.STATE_COMPLETED -> { done.put(d.request.id); continue }
                    Download.STATE_DOWNLOADING -> { o.put("status", "downloading"); o.put("pct", Math.max(0, d.percentDownloaded.toInt())) }
                    Download.STATE_FAILED -> { o.put("status", "failed"); o.put("reason", "Download failed") }
                    Download.STATE_REMOVING -> continue
                    else -> o.put("status", "queued") // queued, stopped, restarting
                }
                active.put(d.request.id, o)
            }
        } finally {
            cursor.close()
        }
        val out = JSObject()
        out.put("done", done)
        out.put("active", active)
        return out
    }

    private fun emitDownloads() {
        notifyListeners("downloads", downloadsObject())
        if (BrookMedia.downloadManager.currentDownloads.isNotEmpty()) {
            main.removeCallbacks(progressTick)
            main.postDelayed(progressTick, 1000)
        }
    }

    @PluginMethod
    fun getDownloads(call: PluginCall) {
        main.post { call.resolve(downloadsObject()) }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val arr = call.getArray("items")
        main.post {
            for (i in 0 until (arr?.length() ?: 0)) {
                val o = arr!!.getJSONObject(i)
                val id = o.getString("id")
                val req = DownloadRequest.Builder(id, Uri.parse(o.getString("url")))
                    .setCustomCacheKey(o.getString("cacheKey"))
                    .build()
                DownloadService.sendAddDownload(context, BrookDownloadService::class.java, req, /* foreground = */ true)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun removeDownloads(call: PluginCall) {
        val ids = call.getArray("ids")
        main.post {
            for (i in 0 until (ids?.length() ?: 0)) BrookMedia.downloadManager.removeDownload(ids!!.getString(i))
            call.resolve()
        }
    }

    @PluginMethod
    fun removeAllDownloads(call: PluginCall) {
        main.post { BrookMedia.downloadManager.removeAllDownloads(); call.resolve() }
    }

    // Stop what is queued or running; songs already saved stay.
    @PluginMethod
    fun cancelDownloads(call: PluginCall) {
        main.post {
            for (d in BrookMedia.downloadManager.currentDownloads) BrookMedia.downloadManager.removeDownload(d.request.id)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        main.post {
            main.removeCallbacks(progressTick)
            BrookMedia.downloadManager.removeListener(downloadListener)
            controller?.removeListener(listener)
            future?.let { MediaController.releaseFuture(it) }
            controller = null
            future = null
        }
    }

    private fun connect() {
        if (future != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val f = MediaController.Builder(context, token).buildAsync()
        future = f
        f.addListener({
            try {
                val c = f.get()
                c.addListener(listener)
                controller = c
                val todo = ArrayList(waiting)
                waiting.clear()
                todo.forEach { it(c) }
                emitState()
            } catch (e: Exception) {
                Log.e(TAG, "cannot connect to the player service", e)
                future = null
                // Reject whatever was waiting, so the web UI does not hang.
                waiting.clear()
            }
        }, ContextCompat.getMainExecutor(context))
    }

    // Run on the main thread, once the controller is connected.
    private fun withController(call: PluginCall?, block: (MediaController) -> Unit) {
        main.post {
            val c = controller
            val run: (MediaController) -> Unit = { ctl ->
                try {
                    block(ctl)
                } catch (e: Exception) {
                    Log.e(TAG, "call failed", e)
                    if (call != null) call.reject(e.message ?: "failed")
                }
            }
            if (c != null) run(c) else {
                waiting.add(run)
                connect()
            }
        }
    }

    private fun toItem(o: JSObject): MediaItem {
        val meta = MediaMetadata.Builder()
            .setTitle(o.getString("title"))
            .setArtist(o.getString("artist"))
            .setAlbumTitle(o.getString("album"))
            .setIsPlayable(true)
            .setIsBrowsable(false)
        val dur = o.optLong("durationMs", 0L)
        if (dur > 0) meta.setDurationMs(dur)
        val art = o.getString("artUrl")
        if (!art.isNullOrEmpty()) meta.setArtworkUri(Uri.parse(art))
        // Whether the player should fetch this song ahead of time (the web UI says no for big originals).
        val extras = android.os.Bundle()
        extras.putBoolean("prefetch", o.optBoolean("prefetch", false))
        meta.setExtras(extras)
        val builder = MediaItem.Builder()
            .setMediaId(o.getString("id") ?: "")
            .setUri(o.getString("url"))
            .setMediaMetadata(meta.build())
        // The cache is keyed by song, not by URL (the URL holds a login token).
        val key = o.getString("cacheKey")
        if (!key.isNullOrEmpty()) builder.setCustomCacheKey(key)
        return builder.build()
    }

    private fun items(arr: JSArray?): List<MediaItem> {
        val out = ArrayList<MediaItem>()
        if (arr == null) return out
        for (i in 0 until arr.length()) out.add(toItem(JSObject.fromJSONObject(arr.getJSONObject(i))))
        return out
    }

    private fun stateObject(c: MediaController): JSObject {
        val item = c.currentMediaItem
        val st = when (c.playbackState) {
            Player.STATE_BUFFERING -> "buffering"
            Player.STATE_READY -> "ready"
            Player.STATE_ENDED -> "ended"
            else -> "idle"
        }
        var dur = c.duration
        if (dur == C.TIME_UNSET || dur <= 0) dur = item?.mediaMetadata?.durationMs ?: 0L
        val o = JSObject()
        // "playing" is what the play button shows: the player is meant to be playing, even if it is still buffering.
        o.put("playing", c.playWhenReady && c.playbackState != Player.STATE_ENDED && c.playbackState != Player.STATE_IDLE)
        o.put("state", st)
        o.put("id", item?.mediaId)
        o.put("index", c.currentMediaItemIndex)
        o.put("positionMs", c.currentPosition.coerceAtLeast(0))
        o.put("durationMs", dur.coerceAtLeast(0))
        o.put("queueSize", c.mediaItemCount)
        val ids = JSArray()
        for (i in 0 until c.mediaItemCount) ids.put(c.getMediaItemAt(i).mediaId)
        o.put("queue", ids)
        return o
    }

    private fun emitState() {
        val c = controller ?: return
        notifyListeners("state", stateObject(c))
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val list = items(call.getArray("items"))
        val start = call.getInt("startIndex", 0) ?: 0
        val pos = call.data.optLong("positionMs", 0L)
        val play = call.getBoolean("play", true) ?: true
        if (list.isEmpty()) { call.resolve(); return }
        withController(call) { c ->
            c.setMediaItems(list, start.coerceIn(0, list.size - 1), pos)
            c.prepare()
            if (play) c.play() else c.pause()
            call.resolve()
        }
    }

    @PluginMethod
    fun setUpcoming(call: PluginCall) {
        val list = items(call.getArray("items"))
        val currentId = call.getString("currentId")
        withController(call) { c ->
            // The player may have moved on since the web UI computed this; then the web UI is told
            // about the new song and sends a fresh list, so this one is simply dropped.
            if (c.currentMediaItem?.mediaId != currentId) { call.resolve(); return@withController }
            val at = c.currentMediaItemIndex
            if (at + 1 < c.mediaItemCount) c.removeMediaItems(at + 1, c.mediaItemCount)
            if (list.isNotEmpty()) c.addMediaItems(list)
            // Keep only a short history: it exists for the Previous button, not to grow forever.
            if (at > KEEP_HISTORY) c.removeMediaItems(0, at - KEEP_HISTORY)
            call.resolve()
        }
    }

    @PluginMethod
    fun play(call: PluginCall) = withController(call) { c ->
        if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
        if (c.playbackState == Player.STATE_IDLE && c.mediaItemCount > 0) c.prepare()
        c.play()
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) = withController(call) { c -> c.pause(); call.resolve() }

    @PluginMethod
    fun seekTo(call: PluginCall) = withController(call) { c ->
        c.seekTo(call.data.optLong("positionMs", 0L).coerceAtLeast(0))
        call.resolve()
    }

    @PluginMethod
    fun next(call: PluginCall) = withController(call) { c -> c.seekToNextMediaItem(); call.resolve() }

    @PluginMethod
    fun previous(call: PluginCall) = withController(call) { c -> c.seekToPreviousMediaItem(); call.resolve() }

    @PluginMethod
    fun getState(call: PluginCall) = withController(call) { c -> call.resolve(stateObject(c)) }

    companion object {
        private const val TAG = "BrookPlayer"
        private const val KEEP_HISTORY = 3
    }
}
