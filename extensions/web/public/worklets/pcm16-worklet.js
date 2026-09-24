// PCM16 AudioWorklet (docs/PLAN.md "Resampling to 16 kHz PCM16"). Runs in an AudioContext created with
// sampleRate 16000, so Chrome has already resampled the mic. Each 100 ms of input becomes one Int16 frame
// (Float32 → Int16, clamped), posted with the context sample index of its first sample so the main thread can
// stamp it on the Session clock. Plain JS: worklets load by URL under the extension CSP (script-src 'self').
class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.frameSamples || 1600;
    this.buf = new Int16Array(this.size);
    this.fill = 0;
    this.start = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      if (this.fill === 0) this.start = currentFrame + i;
      const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i];
      this.buf[this.fill++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      if (this.fill === this.size) {
        this.port.postMessage({ pcm: this.buf.buffer, frame: this.start }, [this.buf.buffer]);
        this.buf = new Int16Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16Processor);
