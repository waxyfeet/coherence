import { createContext } from "react";

/** Presentation policy only. SessionBoundary remains the authority for recovery. */
export const SessionAuthorization = createContext(false);
