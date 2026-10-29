// React inside a plugin file built with `npm run build:plugin`: the app's own React, handed over by the loader
// (src/plugins/registry.ts loadPluginCode), so the plugin's components run in the app's React tree. Not used by the app.
import type * as ReactNS from 'react';

const host = (globalThis as { FlowStateHost?: { React?: typeof ReactNS } }).FlowStateHost;
if (!host?.React) throw new Error('This is a FlowState plugin: load it in FlowState (Plugins > Load plugin file).');
const R = host.React;

export default R;
export const {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = R;
