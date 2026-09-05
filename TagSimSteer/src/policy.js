// A tiny fully-connected policy network: just enough model capacity for the
// 4-input (see env.js's observe()), 1-output (steering target) control
// problem this env poses — no need for anything bigger, and keeping the
// parameter count small (a couple hundred at most) is what makes the
// gradient-free trainer in train.js practical without backprop.
//
// Tanh activations throughout, including the output layer: a bounded
// [-1, 1] output is a natural fit for steering, which has a hard lock limit
// either way (see train.js's actionScale, which maps this to degrees).
export function createPolicy(sizes = [4, 8, 1]) {
  const layers = [];
  for (let i = 0; i < sizes.length - 1; i++) layers.push({ in: sizes[i], out: sizes[i + 1] });
  const paramCount = layers.reduce((n, l) => n + l.in * l.out + l.out, 0);

  // params layout per layer, concatenated in order: [in*out weights, row-major
  // by input index, then `out` biases].
  function forward(params, input) {
    let x = input;
    let offset = 0;
    for (const l of layers) {
      const next = new Array(l.out).fill(0);
      const weightsEnd = offset + l.in * l.out;
      for (let o = 0; o < l.out; o++) {
        let sum = params[weightsEnd + o]; // bias
        for (let i = 0; i < l.in; i++) sum += params[offset + i * l.out + o] * x[i];
        next[o] = Math.tanh(sum);
      }
      x = next;
      offset = weightsEnd + l.out;
    }
    return x;
  }

  return { sizes, layers, paramCount, forward };
}

// Wraps a trained parameter vector into a plain (obs) => steerTargetDeg function — the same shape
// env.step()'s caller already expects from any hand-written test controller.
export function makePolicyFn(policy, params, actionScale) {
  return (obs) => policy.forward(params, obs)[0] * actionScale;
}
