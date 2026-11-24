// Shared by the hosted utility and the optional floating voice controls.
// App-supplied clearances remain bounded by the minimum touch/safe-area margin.
export const utilityRight = "max(12px,env(safe-area-inset-right),var(--tendril-utility-inset-right,0px))";
export const utilityBottom = "max(12px,env(safe-area-inset-bottom),var(--tendril-utility-inset-bottom,0px))";
export const utilityTop = "max(12px,env(safe-area-inset-top))";
export const utilityLeft = "max(12px,env(safe-area-inset-left))";
export const utilityMaxWidth = `calc(100vw - max(12px,env(safe-area-inset-left)) - ${utilityRight})`;

/** Publish the persistent control bar's actual box, including wrapped sensor controls. */
export function observeUtilityBar(bar: HTMLElement): () => void {
  if (typeof ResizeObserver !== "function") return () => {};
  const style = document.documentElement.style;
  const names = ["--tendril-utility-width", "--tendril-utility-height"] as const;
  const previous = names.map(name => ({ value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }));
  let published: string[] = [];
  const observer = new ResizeObserver(() => {
    const box = bar.getBoundingClientRect();
    published = [`${box.width}px`, `${box.height}px`];
    names.forEach((name, index) => style.setProperty(name, published[index]!));
  });
  observer.observe(bar);
  return () => {
    observer.disconnect();
    names.forEach((name, index) => {
      // Do not overwrite a later authored change when this mounting is disposed.
      if (style.getPropertyValue(name) !== published[index]) return;
      const saved = previous[index]!;
      if (saved.value) style.setProperty(name, saved.value, saved.priority);
      else style.removeProperty(name);
    });
  };
}

/** Track window.visualViewport so mobile keyboards never cover chat composers or Stop buttons. */
export function observeVisualViewport(onChange?: (metrics: { viewportHeight: number; keyboardHeight: number }) => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const style = document.documentElement.style;
  const names = ["--tendril-viewport-height", "--tendril-keyboard-height"] as const;
  const previous = names.map(name => ({ value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) }));
  let published: string[] = [];
  let frame = 0;
  const update = () => {
    frame = 0;
    const viewportHeight = Math.max(0, Math.round(vv.height));
    const keyboardHeight = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    published = [`${viewportHeight}px`, `${keyboardHeight}px`];
    names.forEach((name, index) => style.setProperty(name, published[index]!));
    onChange?.({ viewportHeight, keyboardHeight });
  };
  const schedule = () => {
    if (frame) return;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(update);
    else update();
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  update();
  return () => {
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    names.forEach((name, index) => {
      if (style.getPropertyValue(name) !== published[index]) return;
      const saved = previous[index]!;
      if (saved.value) style.setProperty(name, saved.value, saved.priority);
      else style.removeProperty(name);
    });
  };
}
