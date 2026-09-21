import { createContext, useContext, type ReactNode } from "react";
import type { Screenwriter } from "../screenwriter";

const ScreenwriterContext = createContext<Screenwriter | null>(null);

/** Provide the object made by `createScreenwriter`. The app owns its lifetime (`dispose()`). */
export function ScreenwriterProvider({ screenwriter, children }: { screenwriter: Screenwriter; children: ReactNode }) {
  return <ScreenwriterContext.Provider value={screenwriter}>{children}</ScreenwriterContext.Provider>;
}

export function useScreenwriter(): Screenwriter {
  const sw = useContext(ScreenwriterContext);
  if (!sw) throw new Error("useScreenwriter must be used inside <ScreenwriterProvider>");
  return sw;
}
