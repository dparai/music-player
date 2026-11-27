package com.dpk.brook

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the audio chain is told by the web UI: ten band gains in dB (31 Hz ... 16 kHz), the preamp that
 * keeps the boosts from clipping, and whether songs are brought to the same loudness. Saved, so the
 * sound is the same when the player starts without the web page (headset button after a restart).
 */
data class SoundSettings(
    val gainsDb: DoubleArray = DoubleArray(BANDS),
    val preampDb: Double = 0.0,
    val normalize: Boolean = true,
) {
    val isFlat: Boolean get() = gainsDb.all { it == 0.0 }

    override fun equals(other: Any?): Boolean =
        other is SoundSettings && gainsDb.contentEquals(other.gainsDb) && preampDb == other.preampDb && normalize == other.normalize

    override fun hashCode(): Int = gainsDb.contentHashCode() * 31 + preampDb.hashCode() + normalize.hashCode()

    fun toJson(): String =
        JSONObject()
            .put("gains", JSONArray(gainsDb.toList()))
            .put("preamp", preampDb)
            .put("normalize", normalize)
            .toString()

    companion object {
        const val BANDS = 10
        val FREQS = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)

        fun fromJson(json: String?): SoundSettings {
            if (json.isNullOrEmpty()) return SoundSettings()
            return try {
                val o = JSONObject(json)
                val g = o.optJSONArray("gains")
                val gains = DoubleArray(BANDS) { i -> (g?.optDouble(i, 0.0) ?: 0.0).coerceIn(-12.0, 12.0) }
                SoundSettings(gains, o.optDouble("preamp", 0.0).coerceIn(-24.0, 12.0), o.optBoolean("normalize", true))
            } catch (e: Exception) {
                SoundSettings()
            }
        }

        fun load(context: Context): SoundSettings =
            fromJson(context.getSharedPreferences("sound", Context.MODE_PRIVATE).getString("settings", null))

        fun save(context: Context, s: SoundSettings) {
            context.getSharedPreferences("sound", Context.MODE_PRIVATE).edit().putString("settings", s.toJson()).apply()
        }
    }
}
