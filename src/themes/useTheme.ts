import { useSyncExternalStore } from "react";
const read = () => document.documentElement.dataset.theme ?? "dark";
const subscribe = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
};
export const useTheme = () =>
  useSyncExternalStore(subscribe, read, () => "dark");
export const isLightTheme = (theme: string) =>
  theme === "light" || theme === "cute";
