// JSX runtime inside a plugin file built with `npm run build:plugin` (see host/react.ts). Not used by the app.
import type * as JsxNS from 'react/jsx-runtime';

const host = (globalThis as { FlowStateHost?: { jsxRuntime?: typeof JsxNS } }).FlowStateHost;
if (!host?.jsxRuntime) throw new Error('This is a FlowState plugin: load it in FlowState (Plugins > Load plugin file).');

export const { jsx, jsxs, Fragment } = host.jsxRuntime;
