// Shared by the hosted utility and the optional floating voice controls.
// App-supplied clearances remain bounded by the minimum touch/safe-area margin.
export const utilityRight = "max(12px,env(safe-area-inset-right),var(--tendril-utility-inset-right,0px))";
export const utilityBottom = "max(12px,env(safe-area-inset-bottom),var(--tendril-utility-inset-bottom,0px))";
export const utilityTop = "max(12px,env(safe-area-inset-top))";
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
