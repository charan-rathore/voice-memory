// Deterministic model replacement for dense-pressure child-process checks.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@huggingface/transformers")
    return {
      url: new URL("./dense-pressure-model.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  return nextResolve(specifier, context);
}
