package com.dpk.brook

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EqProcessorTest {
    private val rate = 48_000
    private val seconds = 2

    private fun sine(freq: Double, amp: Double, channels: Int = 2): DoubleArray {
        val n = rate * seconds
        return DoubleArray(n * channels) { i -> amp * sin(2 * PI * freq * (i / channels) / rate) }
    }

    private fun encode(x: DoubleArray, enc: Int): ByteBuffer {
        val bytes = when (enc) { C.ENCODING_PCM_16BIT -> 2; C.ENCODING_PCM_24BIT -> 3; else -> 4 }
        val b = ByteBuffer.allocate(x.size * bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (v in x) when (enc) {
            C.ENCODING_PCM_16BIT -> b.putShort(Math.rint(v * 32768).coerceIn(-32768.0, 32767.0).toInt().toShort())
            C.ENCODING_PCM_24BIT -> { val i = Math.rint(v * 8388608).coerceIn(-8388608.0, 8388607.0).toInt(); b.put(i.toByte()); b.put((i shr 8).toByte()); b.put((i shr 16).toByte()) }
            C.ENCODING_PCM_32BIT -> b.putInt(Math.rint(v * 2147483648.0).coerceIn(-2147483648.0, 2147483647.0).toLong().toInt())
            else -> b.putFloat(v.toFloat())
        }
        b.flip()
        return b
    }

    private fun decode(b: ByteBuffer, enc: Int): DoubleArray {
        b.order(ByteOrder.LITTLE_ENDIAN)
        val out = ArrayList<Double>()
        while (b.hasRemaining()) out.add(
            when (enc) {
                C.ENCODING_PCM_16BIT -> b.short / 32768.0
                C.ENCODING_PCM_24BIT -> (((b.get().toInt() and 0xFF) or ((b.get().toInt() and 0xFF) shl 8) or (b.get().toInt() shl 16)) / 8388608.0)
                C.ENCODING_PCM_32BIT -> b.int / 2147483648.0
                else -> b.float.toDouble()
            },
        )
        return out.toDoubleArray()
    }

    private fun run(p: EqProcessor, x: DoubleArray, enc: Int = C.ENCODING_PCM_16BIT, channels: Int = 2): DoubleArray {
        p.configure(AudioFormat(rate, channels, enc))
        p.flush()
        p.queueInput(encode(x, enc))
        return decode(p.output, enc)
    }

    // RMS of the second half, after filters and the gain ramp have settled.
    private fun rms(x: DoubleArray): Double {
        val from = x.size / 2
        var s = 0.0
        for (i in from until x.size) s += x[i] * x[i]
        return sqrt(s / (x.size - from))
    }

    private fun db(ratio: Double) = 20 * log10(ratio)

    private fun gains(band: Int, db: Double): DoubleArray = DoubleArray(10).also { it[band] = db }

    @Test fun flatIsAnExactPassThrough() {
        val p = EqProcessor().apply { update(SoundSettings(normalize = false)) }
        val input = encode(sine(1000.0, 0.5), C.ENCODING_PCM_16BIT)
        val copy = ByteArray(input.remaining()).also { input.duplicate().get(it) }
        p.configure(AudioFormat(rate, 2, C.ENCODING_PCM_16BIT)); p.flush()
        p.queueInput(input)
        val produced = p.output
        val out = ByteArray(produced.remaining()).also { produced.get(it) }
        assertArrayEquals(copy, out)
    }

    @Test fun boostAtABandCentreMatchesItsGain() {
        for (enc in listOf(C.ENCODING_PCM_16BIT, C.ENCODING_PCM_24BIT, C.ENCODING_PCM_32BIT, C.ENCODING_PCM_FLOAT)) {
            val p = EqProcessor().apply { update(SoundSettings(gains(5, 6.0))) } // 1 kHz, peaking
            val x = sine(1000.0, 0.1)
            val y = run(p, x, enc)
            assertEquals("encoding $enc", 6.0, db(rms(y) / rms(x)), 0.15)
        }
    }

    @Test fun aBandDoesNotTouchTonesFarAway() {
        val p = EqProcessor().apply { update(SoundSettings(gains(5, 12.0))) }
        val x = sine(60.0, 0.1)
        assertEquals(0.029, db(rms(run(p, x)) / rms(x)), 0.1)
    }

    @Test fun cutAtAnOuterBandShelves() {
        val low = EqProcessor().apply { update(SoundSettings(gains(0, -9.0))) } // 31 Hz low shelf
        val x = sine(20.0, 0.1)
        // -7.532 dB is what the web equaliser's model (src/lib/sound.ts) gives at 20 Hz: the two must agree.
        assertEquals(-7.532, db(rms(run(low, x)) / rms(x)), 0.1)
        val high = EqProcessor().apply { update(SoundSettings(gains(9, 8.0))) } // 16 kHz high shelf
        val h = sine(20000.0, 0.1)
        assertEquals(7.601, db(rms(run(high, h)) / rms(h)), 0.1)
    }

    @Test fun preampScalesTheLevel() {
        val p = EqProcessor().apply { update(SoundSettings(preampDb = -6.0)) }
        val x = sine(1000.0, 0.4)
        assertEquals(-6.0, db(rms(run(p, x)) / rms(x)), 0.1)
    }

    @Test fun songGainAppliesOnlyWhileNormalizing() {
        val on = EqProcessor().apply { update(SoundSettings(normalize = true)); setItemGainDb(-4.0) }
        val off = EqProcessor().apply { update(SoundSettings(normalize = false)); setItemGainDb(-4.0) }
        val x = sine(1000.0, 0.4)
        assertEquals(-4.0, db(rms(run(on, x)) / rms(x)), 0.1)
        assertEquals(0.0, db(rms(run(off, x)) / rms(x)), 0.05)
    }

    @Test fun theLimiterKeepsABoostFromClipping() {
        val p = EqProcessor().apply { update(SoundSettings(gains(5, 12.0))) }
        val y = run(p, sine(1000.0, 0.9))
        val peak = y.maxOf { abs(it) }
        assertTrue("peak $peak", peak <= 0.96)
        assertTrue("limiter must not crush the signal: rms ${rms(y)}", rms(y) > 0.4)
    }

    @Test fun monoAndSurroundWork() {
        for (ch in listOf(1, 6)) {
            val p = EqProcessor().apply { update(SoundSettings(gains(5, 6.0))) }
            val x = sine(1000.0, 0.1, ch)
            assertEquals("channels $ch", 6.0, db(rms(run(p, x, channels = ch)) / rms(x)), 0.2)
        }
    }

    @Test fun anUnsupportedEncodingIsLeftAlone() {
        val p = EqProcessor()
        try {
            p.configure(AudioFormat(rate, 2, C.ENCODING_PCM_8BIT))
            throw AssertionError("expected UnhandledAudioFormatException")
        } catch (e: androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException) {
            // the sink skips this processor for such audio
        }
    }

    @Test fun settingsSurviveAJsonRoundTripAndRejectJunk() {
        val s = SoundSettings(gains(3, 4.5), -3.2, false)
        assertEquals(s, SoundSettings.fromJson(s.toJson()))
        assertEquals(SoundSettings(), SoundSettings.fromJson("not json"))
        assertEquals(12.0, SoundSettings.fromJson("{\"gains\":[99]}").gainsDb[0], 0.0)
    }
}
