class JarvisCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.block[this.offset++] = sample;
        if (this.offset === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.offset = 0;
        }
      }
    }
    // Outputs remain silent; microphone audio must never play through the speakers.
    return true;
  }
}

registerProcessor("jarvis-capture", JarvisCapture);
