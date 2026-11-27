package com.dpk.brook

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.DatabaseProvider
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.offline.DownloadManager
import java.io.File
import java.util.concurrent.Executors

/**
 * The player's storage. Two caches, both keyed by a song key chosen by the web UI (not by URL, because
 * the URL carries a login token that is the same for one user but must never decide what is stored):
 *
 *  - downloads: songs the user saved on the phone. Never evicted; removed only by the user.
 *  - stream: songs fetched ahead and ones already played, recent first, trimmed to [STREAM_CACHE_BYTES].
 *
 * Playback reads downloads first, then the stream cache, then the network, and only ever writes to the
 * stream cache, so a download is never touched by playback.
 */
@UnstableApi
object BrookMedia {
    const val STREAM_CACHE_BYTES = 1L * 1024 * 1024 * 1024

    private var ready = false
    lateinit var appContext: Context
        private set
    lateinit var databaseProvider: DatabaseProvider
        private set
    lateinit var downloadCache: SimpleCache
        private set
    lateinit var streamCache: SimpleCache
        private set
    lateinit var httpFactory: DefaultHttpDataSource.Factory
        private set
    lateinit var playbackFactory: DataSource.Factory
        private set
    lateinit var downloadManager: DownloadManager
        private set

    // Equaliser, preamp and song gain, in the player's audio path (shared by the player and the plugin).
    val eq = EqProcessor()

    @Volatile var sound = SoundSettings()

    fun applySound(s: SoundSettings) {
        sound = s
        eq.update(s)
        SoundSettings.save(appContext, s)
    }

    // The playing ExoPlayer (set by PlaybackService), for things that act on it from outside the service.
    @Volatile var player: androidx.media3.exoplayer.ExoPlayer? = null

    @Synchronized
    fun init(context: Context) {
        if (ready) return
        val app = context.applicationContext
        appContext = app
        databaseProvider = StandaloneDatabaseProvider(app)
        downloadCache = SimpleCache(File(app.filesDir, "downloads"), NoOpCacheEvictor(), databaseProvider)
        streamCache = SimpleCache(File(app.cacheDir, "stream"), LeastRecentlyUsedCacheEvictor(STREAM_CACHE_BYTES), databaseProvider)
        httpFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)

        // network -> stream cache (read + write) -> downloads (read only)
        val streamLayer = CacheDataSource.Factory()
            .setCache(streamCache)
            .setUpstreamDataSourceFactory(DefaultDataSource.Factory(app, httpFactory))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        playbackFactory = CacheDataSource.Factory()
            .setCache(downloadCache)
            .setCacheWriteDataSinkFactory(null)
            .setUpstreamDataSourceFactory(streamLayer)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

        downloadManager = DownloadManager(
            app, databaseProvider, downloadCache,
            // Downloads read the network directly and write the downloads cache.
            DefaultDataSource.Factory(app, httpFactory),
            Executors.newFixedThreadPool(2),
        ).apply { maxParallelDownloads = 2 }
        sound = SoundSettings.load(app)
        eq.update(sound)
        ready = true
    }

    // The whole song is in this cache.
    fun isFullyCached(cache: Cache, key: String): Boolean {
        val length = androidx.media3.datasource.cache.ContentMetadata.getContentLength(cache.getContentMetadata(key))
        return length > 0 && cache.isCached(key, 0, length)
    }
}
