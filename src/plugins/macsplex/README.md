# MACSPlex Exosome plugin

Analysis of the MACSPlex Exosome Kit (human; 37 marker capture beads and 2 isotype control beads) in FlowState,
following a fixed, versioned method (method specification v1.1, decisions D1 to D14). A Python reference implementation
of the same method (`macsplex_ref`, kept outside this repository) gives identical numbers on the same gates; the plugin
was checked against it on synthetic files (tests/macsplex.test.ts, the same hand-computed values as the reference's
tests) and on real experiments (not in this repository).

## Steps

1. **Layout (D1).** A CSV pasted into the plugin: `well, role, sample_id, condition, dose, replicate_group,
   blank_group, planned_volume_uL, failed`. Roles: sample, blank (beads + buffer + detection reagent), unstained,
   sa_control, isotype_only, empty. Each sample is matched to its well by the FCS keyword `$SMNO`.
2. **Gates in checked steps (D2).** One gate set for the whole plate:
   1. template: the bead positions of a CytExpert experiment (gates imported from its .xit, or a template pasted as
      JSON);
   2. auto-gating: `fs.autoGate` around each bead's template position in a reference well (default: the sample with
      the most events), all in one undo step; or, in validation mode, the template polygons as they are (linear scales);
   3. check: per bead, events and reporter median of the current gate against the template gate, in the reference
      well and over all wells; differences above a limit (default 10%, provisional) are flagged `gate_check`;
   4. manual correction of the shared gate in the gating view where needed (flag `gate_corrected`);
   5. confirmation; any later gate change removes it.
3. **Reporter (D3).** Median of the reporter channel (default R660-APC-A) per bead population and well, from
   `fs.stat` (identical to the Statistics tables).
4. **Background (D6, D8).** Model A: the median minus the mean of the medians of the well's blank group (same bead).
   Model B (D7, optional, off by default; for PS/PE probes): offsets from unstained wells, then minus the mean of the
   REA and mIgG1 control beads in the same well.
5. **Normalization (D9).** Model A divided by the mean model A of CD9, CD63 and CD81 in the same well; not computed
   when one of them has no events or the mean is not positive.
6. **Replicates (D10).** Mean, SD (n - 1), CV and n of model A per replicate group and bead; only failed wells (empty
   gate, `failed` in the layout) are left out.
7. **No detection call (D12).** Values are continuous; a value near 0 is not evidence that a marker is absent (the
   beads-only blank does not remove EVs binding non-specifically to capture beads).
8. **Flags (D4, D5, D11, D14), which never change or remove a value.** Bead: `empty_gate`, `very_low_events` (< 20),
   `low_events` (20 to 49), `below_background`, `missing_blank`, `norm_not_computed`, `norm_low_events`,
   `failed_well`. Well: `not_loaded`, `early_stop` (`$VOL` < 95% of the planned volume; `$VOL` in nL),
   `low_singles` (< 10,000), `low_assignment` (< 50% of single beads in a bead gate), `negative_isotype`. Replicate
   group: `n_lt_2`, `replicate_cv` (> 30%). Blank group: `blank_cv` (> 30%), `blank_n_lt_3`. Plate: `order_trend`
   (Spearman of single beads vs acquisition order from `$DATE` / `$BTIM` below -0.5), `gates_template`. All limits are
   adjustable; those marked provisional in the specification are not yet validated.
9. **Export.** `summary`, `beads`, `wells`, `blanks`, `gates`, `run` as CSV or one Excel workbook; values unrounded.

## Why `fs.events` is used

- **Confidence interval of each median (D13):** a distribution-free 95% CI from order statistics (ranks from the
  binomial distribution with p = 0.5, summed in log space), which needs the event values. Deterministic, so the plugin
  and the Python reference agree exactly. No CI below 6 events.
- **Gate check (D2 step 3):** the template polygon's events and median are computed from the single-bead events
  (point in polygon in raw linear space), without adding the template gates as populations.

Medians themselves always come from `fs.stat`.

## Known limits

- Auto-gating sparse populations that lie close together can merge them; step 3 shows it (`gate_check`).
- A gate corrected for one well only cannot be seen by a plugin (API request); the method requires one gate set per
  plate.
- Auto-gated and hand-drawn polygons follow the workspace's axis scales; changing a scale later can change counts
  (API request: return gates with their scales).
- The layout is pasted, not opened as a file (API request: `fs.openFile`).

## References

- Wiklander OPB et al. Systematic methodological evaluation of a multiplex bead-based flow cytometry assay for
  detection of extracellular vesicle surface signatures. Front Immunol 2018;9:1326. doi:10.3389/fimmu.2018.01326
- Koliha N et al. A novel multiplex bead-based platform highlights the diversity of extracellular vesicles.
  J Extracell Vesicles 2016;5:29975. doi:10.3402/jev.v5.29975
- MACSPlex Exosome Kit, human: Miltenyi Biotec product documentation.
