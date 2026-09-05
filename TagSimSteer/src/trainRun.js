// Runnable entry point: `npm run train` (or `node src/trainRun.js` from
// TagSimSteer/). Trains policy.js's tiny network against env.js's default
// single-corner course using train.js's CEM loop, logs progress, then
// evaluates the trained policy deterministically (no exploration noise) and
// writes its parameters to trained-policy.json.
//
// This is the only file in src/ that touches Node's filesystem — everything
// else (simCore/course/env/policy/train) is plain, browser-safe ESM with no
// Node-specific APIs, importable from the live component too.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEnv, DEFAULT_COURSE_OPTIONS } from "./env.js";
import { createPolicy, makePolicyFn } from "./policy.js";
import { trainCEM, rollout } from "./train.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const env = createEnv(DEFAULT_COURSE_OPTIONS);
const policy = createPolicy([4, 8, 1]);

console.log(`Training on the default corner (radius ${DEFAULT_COURSE_OPTIONS.radius}m, ` +
  `${DEFAULT_COURSE_OPTIONS.turnDeg}deg ${DEFAULT_COURSE_OPTIONS.direction}, ` +
  `lane half-width ${DEFAULT_COURSE_OPTIONS.laneHalfWidth}m) — ${policy.paramCount} parameters.\n`);

const result = trainCEM({
  env,
  policy,
  generations: 60,
  populationSize: 64,
  eliteFraction: 0.2,
  onGeneration: (s) => {
    if (s.gen % 5 === 0 || s.gen === 59) {
      console.log(`gen ${String(s.gen).padStart(2)}  best=${s.bestFitness.toFixed(1)}  mean=${s.meanFitness.toFixed(1)}  overallBest=${s.overallBest.toFixed(1)}`);
    }
  },
});

console.log(`\nTraining done. Best fitness found: ${result.fitness.toFixed(2)}`);

// Deterministic re-evaluation of the winning parameters (training itself only ever sees noisy
// sampled candidates, never the elite mean directly) — this is the number that actually matters.
const policyFn = makePolicyFn(policy, result.params, 50);
const finalRun = rollout(env, policyFn, 1 / 60, 1800);
console.log(`Deterministic evaluation: total reward=${finalRun.total.toFixed(2)}, steps=${finalRun.steps}`);
console.log(`  info:`, finalRun.info);

const outPath = join(__dirname, "trained-policy.json");
writeFileSync(outPath, JSON.stringify({
  sizes: policy.sizes,
  params: Array.from(result.params),
  actionScale: 50,
  courseOptions: DEFAULT_COURSE_OPTIONS,
  fitness: result.fitness,
  trainedAt: new Date().toISOString(),
}, null, 2));
console.log(`\nSaved trained policy to ${outPath}`);
