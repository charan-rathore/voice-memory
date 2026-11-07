// A model pipeline may be used by several asynchronous inferences. Parsing
// must wait until they finish before disposing the shared ONNX session.
// One pause blocks new leases; nested upload pauses release independently.
export function createModelLifetime() {
  let active = 0;
  let pauses = 0;
  const waiters = [];

  return {
    acquire() {
      if (pauses) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        if (!active) {
          while (waiters.length) waiters.shift()();
        }
      };
    },
    pause() {
      pauses++;
    },
    resume() {
      pauses = Math.max(0, pauses - 1);
    },
    drained() {
      return active
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve();
    },
    get blocked() {
      return pauses > 0;
    },
    get active() {
      return active;
    },
  };
}
