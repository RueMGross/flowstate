// Built-in plugins, shipped with the app: add yours to the list (see docs/PLUGINS.md).
import type { FlowStatePlugin } from './api';
import example from './example';

const ENV = (import.meta as { env?: Record<string, unknown> }).env;

/** The example is a template for developers: listed in the development server (npm run dev) and the tests only. */
export const BUILTIN_PLUGINS: FlowStatePlugin<any>[] = [...(ENV?.DEV === true ? [example] : [])];
