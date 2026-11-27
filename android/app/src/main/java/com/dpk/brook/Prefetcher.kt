package com.dpk.brook

import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Downloads the next few songs into the stream cache while the network is there, so that a song
 * change with the screen off or the network gone (a tunnel, a lift) is played from the phone.
 * Only songs the web UI marked as worth it (the compressed tiers, not 40 MB FLACs).
 */
@UnstableApi
class Prefetcher {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "brook-prefetch") }
    private val generation = AtomicInteger(0)
    @Volatile private var writer: CacheWriter? = null

    /** Fetch [items] in order, replacing whatever was being fetched before. */
    fun fetch(items: List<MediaItem>) {
        val gen = generation.incrementAndGet()
        writer?.cancel()
        executor.execute {
            for (item in items) {
                if (gen != generation.get()) return@execute
                val key = item.localConfiguration?.customCacheKey ?: continue
                val uri = item.localConfiguration?.uri ?: continue
                if (BrookMedia.isFullyCached(BrookMedia.downloadCache, key) || BrookMedia.isFullyCached(BrookMedia.streamCache, key)) continue
                val source = CacheDataSource.Factory()
                    .setCache(BrookMedia.streamCache)
                    .setUpstreamDataSourceFactory(BrookMedia.httpFactory)
                    .createDataSource()
                val spec = DataSpec.Builder().setUri(uri).setKey(key).build()
                val w = CacheWriter(source, spec, null, null)
                writer = w
                try {
                    val started = System.currentTimeMillis()
                    w.cache()
                    Log.i(TAG, "prefetched $key in ${System.currentTimeMillis() - started} ms")
                } catch (e: Exception) {
                    // Cancelled (a newer queue), or the network failed: playback fetches it itself when needed.
                    if (gen == generation.get()) Log.w(TAG, "prefetch of $key failed: ${e.message}")
                    return@execute
                } finally {
                    if (writer === w) writer = null
                }
            }
        }
    }

    fun cancel() {
        generation.incrementAndGet()
        writer?.cancel()
    }

    companion object {
        private const val TAG = "BrookPlayer"
    }
}
