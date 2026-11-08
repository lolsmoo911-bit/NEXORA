function isRecord(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('state contains a non-finite number');
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stableValue(value[k])]));
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function validateStateV2(state) {
  if (!isRecord(state) || state.version !== 2) throw new TypeError('expected state version 2');
  if (typeof state.scenarioId !== 'string' || !state.scenarioId.trim()) throw new TypeError('scenarioId must be a non-empty string');
  if (!isRecord(state.inputs)) throw new TypeError('inputs must be an object');
  if (!isRecord(state.assumptions)) throw new TypeError('assumptions must be an object');
  if (state.outputs !== null && !isRecord(state.outputs)) throw new TypeError('outputs must be an object or null');
  return state;
}

/** Migrate the model package's own serialized state only; never reads chain state files. */
export function migrateModelState(serialized) {
  if (typeof serialized !== 'string') throw new TypeError('serialized state must be a string');
  let state;
  try { state = JSON.parse(serialized); } catch { throw new SyntaxError('serialized state is not valid JSON'); }
  if (!isRecord(state) || !Number.isInteger(state.version)) throw new TypeError('state must have an integer version');
  if (state.version > 2) throw new RangeError(`unsupported future state version: ${state.version}`);
  if (state.version === 1) {
    if (typeof state.scenarioId !== 'string' || !state.scenarioId.trim() || !isRecord(state.inputs)) {
      throw new TypeError('version 1 state requires scenarioId and inputs');
    }
    state = {
      version: 2,
      scenarioId: state.scenarioId,
      inputs: state.inputs,
      assumptions: {},
      outputs: null,
    };
  }
  validateStateV2(state);
  return stableStringify(state);
}
