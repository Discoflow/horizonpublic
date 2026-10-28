/** Edge-triggered alert state transition. Evaluate only finalized observations for RSI rules. */
export function evaluateAlert(rule, previousValue, currentValue, { finalized = true } = {}) {
  if (!rule.enabled || !Number.isFinite(currentValue) || (rule.metric === 'rsi' && !finalized)) return { triggered: false, armed: rule.armed, reason: 'not_evaluable' };
  const crossed = rule.operator === 'below' ? currentValue < rule.threshold : currentValue > rule.threshold;
  const wasTrue = Number.isFinite(previousValue) && (rule.operator === 'below' ? previousValue < rule.threshold : previousValue > rule.threshold);
  if (!crossed) return { triggered: false, armed: true, reason: 'rearmed' };
  if (!rule.armed || wasTrue) return { triggered: false, armed: false, reason: 'condition_still_true' };
  return { triggered: true, armed: false, reason: 'crossed' };
}
