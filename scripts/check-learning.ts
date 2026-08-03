/**
 * Does the learner learn, and does it fail safely? (PLAN.md §10)
 *
 *   npm run check:learning
 *
 * There is no real choice log yet — nobody has used the app enough to make one
 * — so this drives the learner with synthetic walkers whose preferences we
 * know, and checks it recovers them. That is weaker evidence than real data,
 * and it is stated plainly rather than dressed up: it proves the maths is
 * wired correctly, not that the model captures anybody's actual taste.
 *
 * What it does catch is the failure §10 warns about most: a learner that
 * drifts somewhere strange on noisy input, or that quietly encodes position
 * bias as preference.
 */
import { AXIS_KEYS, DEFAULT_WEIGHTS, type ScenicAxis } from "../lib/features";
import {
  learnFromLog,
  positionBias,
  shuffled,
  type Choice,
  type FeatureVector,
} from "../lib/learning";

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260803);

function randomWalk(): FeatureVector {
  return AXIS_KEYS.map(() => rand());
}

/**
 * A walker with a fixed, hidden taste who always picks the option their own
 * weights score highest — the easiest case the learner should manage.
 */
function simulate(trueWeights: number[], rounds: number): Choice[] {
  const log: Choice[] = [];
  for (let i = 0; i < rounds; i++) {
    const options = shuffled([randomWalk(), randomWalk(), randomWalk()], rand);
    let best = 0;
    let bestScore = -Infinity;
    options.forEach((o, idx) => {
      const score = o.reduce((s, x, k) => s + trueWeights[k] * x, 0);
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    });
    log.push({ at: new Date().toISOString(), shown: options, chosenIndex: best });
  }
  return log;
}

/** A walker who always takes the top option, whatever it is. */
function simulatePositionOnly(rounds: number): Choice[] {
  const log: Choice[] = [];
  for (let i = 0; i < rounds; i++) {
    log.push({
      at: new Date().toISOString(),
      shown: [randomWalk(), randomWalk(), randomWalk()],
      chosenIndex: 0,
    });
  }
  return log;
}

function main() {
  let failures = 0;

  // ---- 1. Does it move toward a taste it can see? ------------------------
  const declared = { ...DEFAULT_WEIGHTS };
  const green = AXIS_KEYS.indexOf("green");
  const quiet = AXIS_KEYS.indexOf("quiet");
  const truth = AXIS_KEYS.map((_, i) => (i === green || i === quiet ? 1 : 0.1));

  const log = simulate(truth, 60);
  const learned = learnFromLog(declared, log);

  const favoured = (learned.green + learned.quiet) / 2;
  const rest =
    AXIS_KEYS.filter((a) => a !== "green" && a !== "quiet")
      .reduce((s, a) => s + learned[a], 0) / (AXIS_KEYS.length - 2);

  console.log("a walker who only likes green + quiet, after 60 choices:");
  for (const axis of AXIS_KEYS) {
    console.log(`  ${axis.padEnd(13)} ${declared[axis].toFixed(2)} → ${learned[axis].toFixed(2)}`);
  }
  // A real margin, not merely "greater than". An earlier version separated a
  // walker who only likes green and quiet from one who likes everything by
  // 0.03 and passed — which told us nothing except that the sign was right.
  const MARGIN = 0.15;
  if (favoured - rest >= MARGIN) {
    console.log(
      `✓ favoured axes ${favoured.toFixed(2)} vs others ${rest.toFixed(2)} ` +
        `(gap ${(favoured - rest).toFixed(2)}, need ${MARGIN})\n`,
    );
  } else {
    failures++;
    console.log(
      `✗ gap of ${(favoured - rest).toFixed(2)} is too small to be learning ` +
        `anything (need ${MARGIN})\n`,
    );
  }

  // ---- 2. Does regularisation keep it from running away? -----------------
  const extreme = learnFromLog(declared, simulate(truth, 500));
  const outOfBand = AXIS_KEYS.filter((a) => extreme[a] < 0 || extreme[a] > 1);
  if (outOfBand.length === 0) {
    console.log("✓ 500 choices stay inside [0,1] — regularisation holds\n");
  } else {
    failures++;
    console.log(`✗ weights escaped their band: ${outOfBand.join(", ")}\n`);
  }

  // ---- 3. Is position bias detectable? -----------------------------------
  const biased = positionBias(simulatePositionOnly(40));
  const fair = positionBias(log);
  console.log(`position skew — always-picks-first: ${biased.skew.toFixed(2)}, real taste: ${fair.skew.toFixed(2)}`);
  if (biased.skew > 0.9 && fair.skew < 0.5) {
    console.log("✓ a position-only walker is distinguishable from a real one\n");
  } else {
    failures++;
    console.log("✗ position bias is not separable from preference — the learner can't be trusted\n");
  }

  // ---- 4. Does a short log leave the declared weights alone? -------------
  const short = learnFromLog(declared, log.slice(0, 3));
  const moved = AXIS_KEYS.some((a) => Math.abs(short[a] - declared[a]) > 0.3);
  if (!moved) {
    console.log("✓ three choices barely move the weights — no fitting to noise");
  } else {
    failures++;
    console.log("✗ three choices moved the weights a lot — it's fitting noise");
  }

  console.log(
    failures
      ? `\n${failures} check(s) failed`
      : "\nall checks pass — note this is synthetic, not evidence about real taste",
  );
  process.exit(failures ? 1 : 0);
}

main();
