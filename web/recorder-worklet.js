/**
 * AudioWorkletProcessor: device audio -> mono -> 16 kHz -> Int16 -> 5120-byte frames.
 *
 * Why a worklet instead of ScriptProcessorNode: the latter is deprecated and
 * audibly drops samples on iOS under load, which is exactly the failure mode we
 * cannot afford during a 30-minute talk.
 *
 * The processor is pull-driven at the device rate (usually 44.1/48 kHz), so the
 * resampling position has to survive across the 128-sample quantum boundary.
 * We keep one source sample of history for the interpolator instead of
 * resampling each block independently, which would add a periodic pitch wobble.
 */

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 2560; // 160 ms at 16 kHz -> 5120 bytes of Int16
// If the main thread stops draining (socket stalled), bound the source buffer
// rather than growing forever. Oldest audio is discarded and counted.
const MAX_SOURCE_SAMPLES = TARGET_RATE * 4;

class PcSamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || TARGET_RATE;
    this.sourceRate = sampleRate; // provided by the AudioWorkletGlobalScope
    this.ratio = this.sourceRate / this.targetRate;
    this.frameSamples = opts.frameSamples || FRAME_SAMPLES;

    this.src = new Float32Array(0);
    this.readPos = 0; // fractional index into src
    this.out = new Int16Array(this.frameSamples);
    this.outLen = 0;
    this.droppedSamples = 0;
    this.convertBuffer = new Int16Array(this.frameSamples * 4);
  }

  appendMono(block) {
    const merged = new Float32Array(this.src.length + block.length);
    merged.set(this.src, 0);
    merged.set(block, this.src.length);
    this.src = merged;
  }

  trimConsumed() {
    // Keep a single sample of history so the next block can interpolate.
    const keepFrom = Math.max(0, Math.floor(this.readPos) - 1);
    if (keepFrom === 0) return;
    this.src = this.src.subarray(keepFrom);
    this.readPos -= keepFrom;
  }

  process(inputs) {
    const input = inputs && inputs[0];
    if (!input || !input.length) return true;

    // Down-mix to mono.
    const n = input[0].length;
    const mono = input.length === 1 ? input[0] : new Float32Array(n);
    if (input.length > 1) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) sum += input[c][i];
        mono[i] = sum / input.length;
      }
    }
    this.appendMono(mono);

    // Hard bound: drop from the front if the consumer fell behind badly.
    if (this.src.length > MAX_SOURCE_SAMPLES) {
      const excess = this.src.length - MAX_SOURCE_SAMPLES;
      this.src = this.src.subarray(excess);
      this.readPos = Math.max(0, this.readPos - excess);
      this.droppedSamples += excess;
      this.port.postMessage({ type: 'drops', droppedSamples: this.droppedSamples });
    }

    // Resample by linear interpolation at the target rate.
    const conv = this.convertBuffer;
    let produced = 0;
    while (this.readPos + 1 < this.src.length && produced < conv.length) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      let s = this.src[i] * (1 - frac) + this.src[i + 1] * frac;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      conv[produced++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      this.readPos += this.ratio;
    }

    let offset = 0;
    while (offset < produced) {
      const take = Math.min(this.frameSamples - this.outLen, produced - offset);
      this.out.set(conv.subarray(offset, offset + take), this.outLen);
      this.outLen += take;
      offset += take;
      if (this.outLen === this.frameSamples) {
        const frame = this.out.slice(); // copy: buffer is reused immediately
        this.port.postMessage({ type: 'frame', frame }, [frame.buffer]);
        this.outLen = 0;
      }
    }

    this.trimConsumed();
    return true;
  }
}

registerProcessor('pcm-sampler', PcSamplerProcessor);
