// Training loop for policy.js's tiny network, using the cross-entropy method
// (CEM) rather than a gradient-based algorithm (PPO, REINFORCE, ...): CEM
// needs no backprop/autodiff, just the ability to run an episode and read
// off its total reward, which env.js already provides directly. With a
// parameter count in the low hundreds and an episode costing well under a
// millisecond to simulate, a population-based, gradient-free search
// converges in a fraction of a second of wall-clock time — there's no need
// for a heavier algorithm or an autodiff library for a policy this small.
//
// CEM itself: maintain a diagonal Gaussian (mean + per-parameter std) over
// the parameter vector. Each generation, sample a population from it, run
// one episode per candidate to score it, refit the mean/std to the
// top-`eliteFraction` performers, repeat. No learning rate to tune (unlike
// OpenAI-ES-style gradient estimates) — it's just "fit a distribution to
// what worked," which is part of why it's a reasonable first algorithm here.
import { reset, step } from "./env.js";

// Runs one episode with a fixed parameter vector, returns its total reward.
// `policyFn` closes over `policy`/`params`/`actionScale` — see policy.js's
// makePolicyFn for the same shape used outside training (e.g. a replay).
function rollout(env, policyFn, dt, maxSteps) {
  let ep = reset(env);
  let total = 0;
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const steerTargetDeg = policyFn(ep.obs);
    ep = step(env, ep, { steerTargetDeg }, dt);
    total += ep.reward;
    if (ep.done) break;
  }
  return { total, steps: steps + 1, info: ep.info };
}
export { rollout };

// Small seedable PRNG (mulberry32) + Box-Muller — deterministic training
// runs given the same seed, without pulling in a random-number-generator
// dependency for what's a handful of lines.
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// env: created via createEnv() (env.js) — the course/vehicle to train against.
// policy: created via createPolicy() (policy.js).
// onGeneration(stats): optional progress callback, called once per generation.
export function trainCEM({
  env,
  policy,
  dt = 1 / 60,
  maxSteps = 1800, // 30s at 60Hz — matches env.js's own episode timeout
  generations = 40,
  populationSize = 64,
  eliteFraction = 0.2,
  initialStd = 1.0,
  minStd = 0.05,
  actionScale = 50, // degrees — matches MAX_LOCK_DEG in simCore.js
  seed = 1,
  onGeneration,
} = {}) {
  const rng = mulberry32(seed);
  const n = policy.paramCount;
  const mean = new Float64Array(n); // start at all-zero = the "do nothing" policy
  const std = new Float64Array(n).fill(initialStd);
  const eliteCount = Math.max(1, Math.round(populationSize * eliteFraction));
  const history = [];
  let best = { fitness: -Infinity, params: mean.slice() };

  for (let gen = 0; gen < generations; gen++) {
    const population = [];
    for (let i = 0; i < populationSize; i++) {
      const params = new Float64Array(n);
      for (let j = 0; j < n; j++) params[j] = mean[j] + std[j] * gaussian(rng);
      const policyFn = (obs) => policy.forward(params, obs)[0] * actionScale;
      const { total } = rollout(env, policyFn, dt, maxSteps);
      population.push({ params, fitness: total });
      if (total > best.fitness) best = { fitness: total, params: params.slice() };
    }
    population.sort((a, b) => b.fitness - a.fitness);
    const elites = population.slice(0, eliteCount);
    for (let j = 0; j < n; j++) {
      let m = 0;
      for (const e of elites) m += e.params[j];
      m /= elites.length;
      let v = 0;
      for (const e of elites) v += (e.params[j] - m) ** 2;
      v /= elites.length;
      mean[j] = m;
      std[j] = Math.max(minStd, Math.sqrt(v));
    }
    const meanFitness = population.reduce((s, p) => s + p.fitness, 0) / population.length;
    const stats = { gen, bestFitness: population[0].fitness, meanFitness, overallBest: best.fitness };
    history.push(stats);
    onGeneration?.(stats);
  }

  return { params: best.params, fitness: best.fitness, history };
}
