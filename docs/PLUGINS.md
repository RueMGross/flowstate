# Writing FlowState plugins

Plugins add workflows for particular assays on top of FlowState's own data, gates and statistics: bead-based multiplex
assays (MACSPlex, LEGENDplex and similar), plate assays, kit-specific reports. A plugin is a page of its own (the
**Plugins** tab) that reads samples, gates bead populations, takes statistics exactly as the Statistics tables compute
them, and exports results.

A plugin reaches the app only through one object, `fs` (the `PluginContext`). Because of that, the same plugin code
runs in two ways:

- **built in**: its folder is in `src/plugins/` and listed in `src/plugins/index.ts`; it ships with FlowState after
  review (pull request).
- **from a file**: `npm run build:plugin -- <id>` makes one `.js` file that anyone can load into a running FlowState
  (Plugins > Load plugin file), without rebuilding the app. Use this to try a plugin on real data or share a test
  version. A loaded file stays for the session only.

The whole contract is in [`src/plugins/api.ts`](../src/plugins/api.ts); a complete working example is in
[`src/plugins/example/`](../src/plugins/example/).

## Quick start

```sh
git clone https://github.com/RueMGross/flowstate.git
cd flowstate
npm install
cp -r src/plugins/example src/plugins/macsplex     # your plugin's folder; the folder name is its id
```

1. In `src/plugins/macsplex/index.tsx` set `id: 'macsplex'`, `name`, `version`, `description`, `author`.
2. List it in `src/plugins/index.ts`:

   ```ts
   import macsplex from './macsplex';
   export const BUILTIN_PLUGINS: FlowStatePlugin<any>[] = [macsplex, ...(ENV?.DEV === true ? [example] : [])];
   ```

3. `npm run dev`, open the address it prints, load some FCS files, then the **Plugins** tab. Changes to your files show
   up right away.
4. Write tests next to the others (`tests/macsplex.test.ts`; `tests/plugins.test.ts` shows how to load synthetic FCS
   files and test a plugin's numbers) and run `npm test` and `npm run typecheck`.

To try it in the deployed FlowState without a new release: `npm run build:plugin -- macsplex`, then in FlowState
Plugins > Load plugin file > `dist-plugins/macsplex.flowstate-plugin.js`.

## A plugin

```tsx
import { PLUGIN_API_VERSION, type FlowStatePlugin, type PluginPageProps } from '../api';

interface Settings { reporter: string; beads: string[] }

function Page({ fs, revision }: PluginPageProps<Settings>) {
  const s = fs.getState() ?? { reporter: '', beads: [] };
  // anything read from fs depends on `revision` (it changes when gates, samples or data change)
  const rows = useMemo(() => fs.samples().map((x) => [x.name, ...s.beads.map((b) => fs.stat(x.id, b, 'median', s.reporter))]), [fs, s, revision]);
  return <table className="data">{/* ... */}</table>;
}

const plugin: FlowStatePlugin<Settings> = {
  apiVersion: PLUGIN_API_VERSION,   // the API version you wrote it for
  id: 'macsplex',                   // lowercase letters, digits, "-"
  name: 'MACSPlex Exosome',
  version: '0.1.0',
  Page,
  parseState: (raw) => /* check / upgrade saved settings, or null */ raw as Settings,
};
export default plugin;
```

`Page` is an ordinary React component. It gets `fs` (stable) and `revision` (a number that changes whenever results may
change). The app's look is available through its CSS classes: `card`, `card-head`, `card-body`, `btn`, `btn sm`,
`btn primary`, `inp` (inputs and selects), `hint`, `tbl-wrap` with `table.data`. A plugin that throws while rendering
shows an error in its page; the rest of the app keeps working.

## What `fs` offers

| | |
| --- | --- |
| `samples()` | samples with name, file, event count, whether loaded, FCS keywords, groups, plate, well and the plate layout's annotations of the well (e.g. standard concentrations) |
| `channels()`, `findChannel(q)` | channels with marker labels; find one by name or marker ("APC-A", "CD63") |
| `populations()`, `groups()` | the gating tree (id, name, parent, path, gate) and the groups |
| `stat(sample, population, stat, channel?, percentile?)` | a statistic exactly as the Statistics tables compute it: `count`, `freqParent`, `freqTotal`, `median`, `mean`, `geomean`, `sd`, `cv`, `rsd`, `rcv`, `percentile`, `mode`, `min`, `max`; NaN when it does not apply |
| `count(sample, population?)` | event count (null when not loaded / not applicable) |
| `events(sample, channel, population?)` | the population's values of a channel (compensated as the sample is), for your own calculations |
| `addGate`, `setGate`, `removePopulation` | gates as in the app (raw channel values; types in `src/core/model.ts`, `GateGeom`) |
| `autoGate({ sampleId, x, y, seed })` | the app's auto gate around a seed point (raw values): the bead population there, as a gate to add |
| `transaction(fn)` | everything `fn` changes is one undo step |
| `getState()`, `setState(v)` | the plugin's own settings / results, saved with the workspace (plain JSON) |
| `saveCsv(name, rows)`, `saveXlsx(name, sheets)` | export |
| `notify(text, kind)` | a short message |

All values are raw (linear) channel values, compensated with the sample's compensation, as everywhere in FlowState.

## Bead-based multiplex assays

The example plugin walks through the usual steps; each is one call or a few:

1. **Find the bead populations.** For a fixed bead layout, store the expected bead positions (raw values on the two
   bead-ID channels) and call `fs.autoGate` once per bead in a reference sample, then `fs.addGate`, all inside one
   `fs.transaction`. Gates can also be drawn by hand in the app; the plugin then lets the user pick them.
2. **Read the reporter.** `fs.stat(sample, bead, 'median', reporter)` per sample and bead population.
3. **Blanks, standards, unknowns.** Let the user choose blank samples, or read roles and standard concentrations from
   the plate layout (`sample.annotations`, filled in the Plates view).
4. **Background subtraction and normalization** (e.g. to the mean of reference beads), in plain TypeScript.
5. **Standard curves** (e.g. 4- or 5-parameter logistic fits for LEGENDplex) in the plugin; keep the fitting code in its
   own file with tests against known values.
6. **Export** with `fs.saveXlsx` / `fs.saveCsv`; keep the settings in `fs.setState` so the analysis reopens as it was.

Put the calculations in a separate file that takes `fs` (see `example/compute.ts`), so they are tested without the UI.

## Rules

- **Only through `fs`.** Do not import the app's state, engine, UI or file modules: `npm run build:plugin` refuses
  them. Pure helpers from `src/core/` (statistics, transforms) may be imported. If you need something `fs` does not
  offer, ask for it: the API grows by adding members, so existing plugins keep working.
- **Numbers.** Take statistics from `fs.stat` (identical to the tables and exports) rather than recomputing them, say
  in the page how values are derived (which statistic, what is subtracted, what is normalized to), and test the
  calculations with known inputs.
- **No data in the repository.** Tests use small synthetic FCS files (see `tests/plugins.test.ts`), never measured or
  unpublished data.
- **Security.** A plugin runs with the app's full access. FlowState asks before loading a plugin file; only load
  files from people you trust.
- **License.** Plugins in this repository are part of FlowState and licensed under AGPL-3.0-only, like the rest (see
  CONTRIBUTING.md).

## Getting a plugin into FlowState

Open a pull request with the plugin folder, its entry in `src/plugins/index.ts` and its tests. Before that:
`npm run typecheck`, `npm test`, and a run on real data compared against the kit's own analysis or a spreadsheet
calculation.
