/**
 * Learning what someone actually likes from what they actually pick.
 *
 * PLAN.md §10. Every time three walks are shown and one is chosen, that's a
 * discrete choice over three feature vectors, which is a multinomial logit —
 * small enough to fit from a few dozen choices by online gradient step.
 *
 * §10 names four ways this poisons itself, and three of them are handled here:
 *
 *   - **Regularise toward the declared preferences.** Without it, a handful of
 *     noisy clicks drags the weights somewhere strange and they never come
 *     back. The pull toward what the user actually said is what keeps the
 *     learned vector a refinement rather than a replacement.
 *   - **Custom interests need stronger regularisation than core axes**, because
 *     they're sparse: one lucky route through three bridges can wildly
 *     over-weight bridges. Not yet applicable — interests aren't in the feature
 *     vector — but the shape is here so adding them is a weight change.
 *   - **Never surface learned weights as a settings screen.** Nothing in this
 *     module is rendered to the walker. The premise is that they never have to
 *     think about it; declared preferences stay editable, learned adjustments
 *     stay invisible.
 *
 * The fourth — randomising presentation order — belongs to the UI, and matters
 * more than anything here: learn from an unshuffled list and you learn "users
 * like the first option", which is true and useless.
 *
 * **Nothing here has been validated against real choices.** It cannot be, until
 * somebody uses the app enough to generate them. Treat the numbers as untested
 * until `positionBias` over a real log says otherwise.
 */
import { AXIS_KEYS, type ScenicAxis } from "./features";

/**
 * What a walk looks like to the learner: its exposure on each axis.
 *
 * Per-kilometre rather than absolute, because §11's sixth hard part warns the
 * loop is confounded by route length as well as by ordering. Without
 * normalising, the model would mostly learn that people pick longer walks,
 * which tells us nothing about what they like.
 */
export type FeatureVector = number[];

export function featureVector(axes: Record<ScenicAxis, number>): FeatureVector {
  return AXIS_KEYS.map((axis) => axes[axis] ?? 0);
}

export type Choice = {
  at: string;
  /** Every option shown, in the order it appeared on screen. */
  shown: FeatureVector[];
  /** Index into `shown` — i.e. the *screen position* that was picked. */
  chosenIndex: number;
  /**
   * Whether the walk was completed, not merely selected.
   *
   * §10: a recorded trace matching the suggested line is a much stronger
   * positive than a click, and should be weighted accordingly. Always false
   * for now — trace recording doesn't exist yet.
   */
  completed?: boolean;
};

/** Weight given to a choice that was merely selected, versus one walked. */
const SELECTED_WEIGHT = 1;
const COMPLETED_WEIGHT = 3;

/** Step size for the online update. Small: a few dozen choices, not thousands. */
const LEARNING_RATE = 0.08;

/**
 * Pull back toward the declared preferences on every step.
 *
 * §10 wants this to stop a handful of noisy clicks dragging the weights
 * somewhere strange — but the default declared vector is 1 on every axis,
 * i.e. "everything matters equally", which is precisely the hypothesis a
 * consistent walker is disproving. Too strong and sustained evidence can never
 * win: at 0.04 a walker who picked green-and-quiet sixty times running was
 * separated from one who likes everything by 0.13.
 *
 * The few-clicks case is guarded twice over regardless — `MIN_CHOICES_TO_LEARN`
 * withholds learned weights until there are eight, and the gradient is tiny
 * when the model already predicts the choice. So this only needs to be firm
 * enough to keep an anchor, not to win arguments against real evidence.
 */
const REGULARISATION = 0.02;

/**
 * Learned weights stay in this band during fitting, then get normalised back
 * to [0,1] before the router sees them.
 *
 * The ceiling is deliberately above 1. Declared weights default to 1 on every
 * axis, so a ceiling of 1 leaves a favoured axis *no room to rise* — the model
 * can only push disfavoured axes down, and regularisation drags those back up
 * every step. The result looked like it worked (favoured did edge ahead) while
 * separating a walker who only likes green and quiet from one who likes
 * everything by 0.03, which is nothing. What matters to the router is the
 * ratio between axes, not the absolute values, so letting them spread and
 * rescaling afterwards costs nothing and makes the learning visible.
 */
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 3;

function softmax(utilities: number[]): number[] {
  // Shift by the max before exponentiating — standard guard against overflow
  // when utilities get large.
  const max = Math.max(...utilities);
  const exp = utilities.map((u) => Math.exp(u - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / total);
}

/**
 * One online gradient step of multinomial logit.
 *
 * The gradient of the log-likelihood with respect to the weights is
 * `x_chosen − Σ_i P_i·x_i`: the features of what they picked, minus what the
 * model expected them to pick. When the model already predicts the choice, the
 * two cancel and nothing moves — which is the behaviour we want as it settles.
 */
export function updateWeights(
  current: Record<ScenicAxis, number>,
  declared: Record<ScenicAxis, number>,
  choice: Choice,
): Record<ScenicAxis, number> {
  const options = choice.shown;
  if (options.length < 2 || !options[choice.chosenIndex]) return current;

  const w = AXIS_KEYS.map((axis) => current[axis] ?? 0);
  const utilities = options.map((x) => x.reduce((sum, xi, i) => sum + w[i] * xi, 0));
  const probabilities = softmax(utilities);

  const chosen = options[choice.chosenIndex];
  const strength = choice.completed ? COMPLETED_WEIGHT : SELECTED_WEIGHT;

  const next = {} as Record<ScenicAxis, number>;
  AXIS_KEYS.forEach((axis, i) => {
    let expected = 0;
    for (let o = 0; o < options.length; o++) expected += probabilities[o] * options[o][i];

    const gradient = chosen[i] - expected;
    const pull = (declared[axis] ?? 0) - w[i];
    const updated = w[i] + LEARNING_RATE * strength * gradient + REGULARISATION * pull;

    next[axis] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, updated));
  });

  return next;
}

/**
 * Rescale so the strongest axis sits at 1.
 *
 * The router wants weights in [0,1]; the learner needs room above that to let
 * axes separate. Dividing by the max preserves every ratio, which is all the
 * scenic blend actually depends on.
 */
export function normaliseWeights(
  weights: Record<ScenicAxis, number>,
): Record<ScenicAxis, number> {
  const max = Math.max(...AXIS_KEYS.map((a) => weights[a] ?? 0));
  if (max <= 0) return weights;
  const out = {} as Record<ScenicAxis, number>;
  for (const axis of AXIS_KEYS) out[axis] = (weights[axis] ?? 0) / max;
  return out;
}

/** Replay a whole log from the declared weights. Used when the log changes wholesale. */
export function learnFromLog(
  declared: Record<ScenicAxis, number>,
  log: Choice[],
): Record<ScenicAxis, number> {
  let weights = { ...declared };
  for (const choice of log) weights = updateWeights(weights, declared, choice);
  return normaliseWeights(weights);
}

export type PositionBias = {
  choices: number;
  /** How often each screen position was chosen. */
  byPosition: number[];
  /**
   * How far the distribution is from uniform, 0–1.
   *
   * §11's sixth hard part: the learning loop is confounded by ordering. Since
   * presentation is randomised, any consistent preference for a position is
   * position bias rather than taste — and if this is high, the learned weights
   * are measuring the wrong thing and shouldn't be trusted.
   */
  skew: number;
};

export function positionBias(log: Choice[], slots = 3): PositionBias {
  const byPosition = new Array<number>(slots).fill(0);
  for (const c of log) {
    if (c.chosenIndex >= 0 && c.chosenIndex < slots) byPosition[c.chosenIndex]++;
  }

  const total = byPosition.reduce((a, b) => a + b, 0);
  if (total === 0) return { choices: 0, byPosition, skew: 0 };

  // Total variation distance from uniform, scaled so 1 means "always the same
  // slot" and 0 means perfectly even.
  const uniform = 1 / slots;
  const deviation =
    byPosition.reduce((sum, n) => sum + Math.abs(n / total - uniform), 0) / 2;
  return { choices: total, byPosition, skew: deviation / (1 - uniform) };
}

/**
 * Shuffle, and report where everything ended up.
 *
 * §10's fourth trap, and the one that has to be right *before* any data is
 * collected: presenting three walks in a fixed order and learning from the
 * picks teaches the model that people like the top of a list. That's true, and
 * useless, and indistinguishable afterwards from a genuine preference — which
 * is why the shuffle can't be retrofitted once a log exists.
 */
export function shuffled<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
