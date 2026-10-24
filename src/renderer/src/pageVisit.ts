import { createContext } from 'react';

/**
 * How many times the page around a component has been shown. Keep-alive pages are hidden with React <Activity>, which
 * runs effect cleanups on hide: anything that is destroyed there for good (the Monaco editor) must remount on the next
 * show, keyed by this number.
 */
export const PageVisit = createContext(0);
