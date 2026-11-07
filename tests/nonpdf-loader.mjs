// Dependency fault used only by format-isolation.test.mjs child processes.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("pdfjs-dist"))
    throw Error("PDF parser must not load for this format");
  return nextResolve(specifier, context);
}
