package com.dpk.brook

import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The equaliser, preamp, per-song loudness gain and a safety limiter, in the player's audio path.
 *
 * Ten biquad filters per channel with the same maths and the same Q as the web version
 * (src/lib/sound.ts, the RBJ cookbook), so a curve sounds the same in the browser and in the app. The
 * outer two bands shelve. Audio is processed in floating point and written back in the format it came in
 * (16-, 24- or 32-bit integer, or float); integer output gets TPDF dither so quiet passages do not
 * get quantisation distortion. When the curve is flat and there is no gain it is an exact pass-through.
 */
@UnstableApi
class EqProcessor : BaseAudioProcessor() {
    @Volatile private var settings = SoundSettings()
    @Volatile private var itemGainDb = 0.0
    @Volatile private var masterGain = 1.0 // 1.0 normally; the sleep timer fades it to 0
    @Volatile var label = ""             // names this processor in the test meter
    @Volatile private var version = 0
    private var appliedVersion = -1

    private var rate = 0
    private var channels = 0
    private var encoding = C.ENCODING_INVALID

    // coefficients per band, then state per channel and band
    private var b0 = DoubleArray(SoundSettings.BANDS)
    private var b1 = DoubleArray(SoundSettings.BANDS)
    private var b2 = DoubleArray(SoundSettings.BANDS)
    private var a1 = DoubleArray(SoundSettings.BANDS)
    private var a2 = DoubleArray(SoundSettings.BANDS)
    private var active = BooleanArray(SoundSettings.BANDS)
    private var z1 = Array(0) { DoubleArray(0) }
    private var z2 = Array(0) { DoubleArray(0) }

    private var gain = 1.0          // smoothed linear gain (preamp * song gain)
    private var targetGain = 1.0
    private var bypass = true
    private var limiterGain = 1.0
    private var rng = 0x2545F491L
    private var samples = DoubleArray(0) // one frame, reused

    /** Test builds only: logs the level going in and out once a second, to check the real audio path. */
    @Volatile var meter = false
    private var meterIn = 0.0
    private var meterOut = 0.0
    private var meterFrames = 0

    fun update(s: SoundSettings) {
        settings = s
        version++
    }

    /** Overall level, 0..1, used for the sleep timer's fade-out. */
    fun setMasterGain(g: Double) {
        masterGain = g
        version++
    }

    /** The loudness trim of the song now playing, in dB (0 when normalising is off). */
    fun setItemGainDb(db: Double) {
        itemGainDb = db
        version++
    }

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        when (inputAudioFormat.encoding) {
            C.ENCODING_PCM_16BIT, C.ENCODING_PCM_24BIT, C.ENCODING_PCM_32BIT, C.ENCODING_PCM_FLOAT -> Unit
            else -> throw UnhandledAudioFormatException(inputAudioFormat)
        }
        rate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount
        encoding = inputAudioFormat.encoding
        z1 = Array(channels) { DoubleArray(SoundSettings.BANDS) }
        z2 = Array(channels) { DoubleArray(SoundSettings.BANDS) }
        samples = DoubleArray(channels)
        appliedVersion = -1
        return inputAudioFormat
    }

    override fun onFlush() {
        for (c in 0 until channels) { z1[c].fill(0.0); z2[c].fill(0.0) }
        limiterGain = 1.0
        gain = targetGain
    }

    private fun refresh() {
        val s = settings
        val v = version
        for (i in 0 until SoundSettings.BANDS) {
            val g = s.gainsDb[i]
            active[i] = g != 0.0
            if (g != 0.0) {
                val c = coefficients(i, g, rate.toDouble())
                b0[i] = c[0]; b1[i] = c[1]; b2[i] = c[2]; a1[i] = c[3]; a2[i] = c[4]
            }
        }
        val song = if (s.normalize) itemGainDb else 0.0
        targetGain = 10.0.pow((s.preampDb + song) / 20.0) * masterGain
        bypass = s.isFlat && abs(s.preampDb + song) < 1e-9 && masterGain == 1.0
        appliedVersion = v
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size == 0) return
        if (appliedVersion != version) refresh()
        val out = replaceOutputBuffer(size)
        if (bypass && abs(gain - 1.0) < 1e-9) {
            out.put(inputBuffer)
            out.flip()
            return
        }
        inputBuffer.order(ByteOrder.LITTLE_ENDIAN)
        out.order(ByteOrder.LITTLE_ENDIAN)
        val bytes = when (encoding) {
            C.ENCODING_PCM_16BIT -> 2
            C.ENCODING_PCM_24BIT -> 3
            else -> 4
        }
        val frames = size / (bytes * channels)
        val smooth = 1.0 - exp(-1.0 / (0.01 * rate)) // 10 ms gain ramp, so a change never clicks
        for (f in 0 until frames) {
            gain += (targetGain - gain) * smooth
            var peak = 0.0
            for (c in 0 until channels) {
                var x = read(inputBuffer)
                if (meter) meterIn += x * x
                for (i in 0 until SoundSettings.BANDS) {
                    if (!active[i]) continue
                    // Direct form II transposed
                    val y = b0[i] * x + z1[c][i]
                    z1[c][i] = b1[i] * x - a1[i] * y + z2[c][i]
                    z2[c][i] = b2[i] * x - a2[i] * y
                    x = y
                }
                x *= gain
                samples[c] = x
                peak = max(peak, abs(x))
            }
            // Limiter: never louder than -0.4 dBFS. It reacts at once and recovers over about 80 ms.
            val need = if (peak > LIMIT) LIMIT / peak else 1.0
            limiterGain = if (need < limiterGain) need else limiterGain + (1.0 - limiterGain) * (1.0 - exp(-1.0 / (0.08 * rate)))
            for (c in 0 until channels) {
                val y = samples[c] * limiterGain
                if (meter) meterOut += y * y
                write(out, y)
            }
            if (meter && ++meterFrames >= rate) {
                val n = (meterFrames * channels).toDouble()
                Log.i("BrookEq", "$label in=%.2f dB out=%.2f dB gain=%.2f dB".format(10 * kotlin.math.log10(meterIn / n + 1e-12), 10 * kotlin.math.log10(meterOut / n + 1e-12), 20 * kotlin.math.log10(gain)))
                meterIn = 0.0; meterOut = 0.0; meterFrames = 0
            }
        }
        inputBuffer.position(inputBuffer.limit())
        out.flip()
    }

    private fun exp(x: Double) = kotlin.math.exp(x)

    private fun read(b: ByteBuffer): Double = when (encoding) {
        C.ENCODING_PCM_16BIT -> b.short / 32768.0
        C.ENCODING_PCM_24BIT -> {
            val v = (b.get().toInt() and 0xFF) or ((b.get().toInt() and 0xFF) shl 8) or (b.get().toInt() shl 16)
            v / 8388608.0
        }
        C.ENCODING_PCM_32BIT -> b.int / 2147483648.0
        else -> b.float.toDouble()
    }

    private fun write(b: ByteBuffer, x: Double) {
        when (encoding) {
            C.ENCODING_PCM_16BIT -> b.putShort(quantise(x, 32768.0, 32767.0).toInt().toShort())
            C.ENCODING_PCM_24BIT -> {
                val v = quantise(x, 8388608.0, 8388607.0).toInt()
                b.put(v.toByte()); b.put((v shr 8).toByte()); b.put((v shr 16).toByte())
            }
            C.ENCODING_PCM_32BIT -> b.putInt(quantise(x, 2147483648.0, 2147483647.0, dither = false).toLong().coerceIn(-2147483648L, 2147483647L).toInt())
            else -> b.putFloat(x.toFloat())
        }
    }

    // TPDF dither of +-1 LSB for 16- and 24-bit output; 32-bit has far more resolution than it needs.
    private fun quantise(x: Double, scale: Double, max: Double, dither: Boolean = true): Double {
        val d = if (dither) (nextUniform() - nextUniform()) else 0.0
        return min(max, max(-scale, Math.rint(x * scale + d)))
    }

    private fun nextUniform(): Double {
        rng = rng xor (rng shl 13)
        rng = rng xor (rng ushr 7)
        rng = rng xor (rng shl 17)
        return ((rng ushr 11).toDouble() / (1L shl 53).toDouble())
    }

    companion object {
        private const val LIMIT = 0.955 // -0.4 dBFS
        private const val Q = 1.41

        /** RBJ biquad coefficients (normalised by a0) for band [band]: lowshelf, peaking or highshelf. */
        fun coefficients(band: Int, gainDb: Double, sampleRate: Double): DoubleArray {
            val freq = SoundSettings.FREQS[band]
            val A = 10.0.pow(gainDb / 40.0)
            val w0 = 2.0 * PI * freq / sampleRate
            val cosw = cos(w0)
            val sinw = sin(w0)
            val b0: Double; val b1: Double; val b2: Double; val a0: Double; val a1: Double; val a2: Double
            if (band != 0 && band != SoundSettings.BANDS - 1) {
                val alpha = sinw / (2.0 * Q)
                b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
                a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
            } else {
                val t = 2.0 * sqrt(A) * (sinw / 2.0 * sqrt(2.0))
                if (band == 0) {
                    b0 = A * ((A + 1) - (A - 1) * cosw + t)
                    b1 = 2 * A * ((A - 1) - (A + 1) * cosw)
                    b2 = A * ((A + 1) - (A - 1) * cosw - t)
                    a0 = (A + 1) + (A - 1) * cosw + t
                    a1 = -2 * ((A - 1) + (A + 1) * cosw)
                    a2 = (A + 1) + (A - 1) * cosw - t
                } else {
                    b0 = A * ((A + 1) + (A - 1) * cosw + t)
                    b1 = -2 * A * ((A - 1) + (A + 1) * cosw)
                    b2 = A * ((A + 1) + (A - 1) * cosw - t)
                    a0 = (A + 1) - (A - 1) * cosw + t
                    a1 = 2 * ((A - 1) - (A + 1) * cosw)
                    a2 = (A + 1) - (A - 1) * cosw - t
                }
            }
            return doubleArrayOf(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
        }
    }
}
