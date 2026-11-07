export const env = {};
export async function pipeline() {
  globalThis.probe.loads++;
  await globalThis.probe.load?.();
  const pipe = async (text) => {
    globalThis.probe.calls++;
    await globalThis.probe.infer?.(text);
    return { data: new Float32Array([0.25, 0.75]) };
  };
  pipe.dispose = async () => {
    globalThis.probe.disposals++;
    await globalThis.probe.dispose?.();
  };
  return pipe;
}
