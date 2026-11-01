class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (output) {
      output.fill(0);
    }

    if (input) {
      let inputOffset = 0;

      while (inputOffset < input.length) {
        const available = this.bufferSize - this.offset;
        const count = Math.min(available, input.length - inputOffset);

        this.buffer.set(
          input.subarray(inputOffset, inputOffset + count),
          this.offset
        );

        this.offset += count;
        inputOffset += count;

        if (this.offset === this.bufferSize) {
          const chunk = this.buffer;
          this.buffer = new Float32Array(this.bufferSize);
          this.offset = 0;

          this.port.postMessage(chunk, [chunk.buffer]);
        }
      }
    }

    return true;
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);