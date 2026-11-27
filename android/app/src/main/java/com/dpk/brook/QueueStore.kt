package com.dpk.brook

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import org.json.JSONArray
import org.json.JSONObject

/**
 * Remembers the queue and the position, so a headset or Bluetooth "play" press resumes the music even
 * when Android has killed the app, and so the player does not come back empty after a restart.
 */
@UnstableApi
class QueueStore(context: Context) {
    private val prefs = context.getSharedPreferences("queue", Context.MODE_PRIVATE)

    fun save(player: Player) {
        if (player.mediaItemCount == 0) return
        val arr = JSONArray()
        for (i in 0 until player.mediaItemCount) {
            val item = player.getMediaItemAt(i)
            val m = item.mediaMetadata
            arr.put(
                JSONObject()
                    .put("id", item.mediaId)
                    .put("uri", item.localConfiguration?.uri?.toString())
                    .put("key", item.localConfiguration?.customCacheKey)
                    .put("title", m.title?.toString())
                    .put("artist", m.artist?.toString())
                    .put("album", m.albumTitle?.toString())
                    .put("art", m.artworkUri?.toString())
                    .put("dur", m.durationMs ?: 0L)
                    .put("prefetch", m.extras?.getBoolean("prefetch", false) ?: false),
            )
        }
        prefs.edit()
            .putString("items", arr.toString())
            .putInt("index", player.currentMediaItemIndex)
            .putLong("pos", player.currentPosition.coerceAtLeast(0))
            .apply()
    }

    fun load(): MediaSession.MediaItemsWithStartPosition? {
        val json = prefs.getString("items", null) ?: return null
        return try {
            val arr = JSONArray(json)
            val items = ArrayList<MediaItem>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val extras = Bundle().apply { putBoolean("prefetch", o.optBoolean("prefetch")) }
                val meta = MediaMetadata.Builder()
                    .setTitle(o.optString("title"))
                    .setArtist(o.optString("artist"))
                    .setAlbumTitle(o.optString("album"))
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setExtras(extras)
                val art = o.optString("art")
                if (art.isNotEmpty() && art != "null") meta.setArtworkUri(Uri.parse(art))
                val dur = o.optLong("dur")
                if (dur > 0) meta.setDurationMs(dur)
                val b = MediaItem.Builder()
                    .setMediaId(o.optString("id"))
                    .setUri(o.optString("uri"))
                    .setMediaMetadata(meta.build())
                val key = o.optString("key")
                if (key.isNotEmpty() && key != "null") b.setCustomCacheKey(key)
                items.add(b.build())
            }
            if (items.isEmpty()) return null
            MediaSession.MediaItemsWithStartPosition(items, prefs.getInt("index", 0).coerceIn(0, items.size - 1), prefs.getLong("pos", 0L))
        } catch (e: Exception) {
            null
        }
    }
}
