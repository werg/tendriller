// packages/peer-session/src/lifetime.ts
function awaitOwnedTask(signal, call) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clear = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      clear();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    let result;
    try {
      result = call();
    } catch (error) {
      clear();
      reject(error);
      return;
    }
    void Promise.resolve(result).then((value) => {
      clear();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error) => {
      clear();
      reject(error);
    });
  });
}

export {
  awaitOwnedTask
};
