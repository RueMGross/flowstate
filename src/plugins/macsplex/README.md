# MACSPlex Exosome plugin

Analysis of the MACSPlex Exosome Kit (human; 37 marker capture beads and 2 isotype control beads) in FlowState,
following a fixed, versioned method (method specification v1.3, decisions D1 to D14). A Python reference implementation
of the same method (`macsplex_ref`, kept outside this repository) gives identical numbers on the same gates; the plugin
was checked against it on synthetic files (tests/macsplex.test.ts, the same hand-computed values as the reference's
tests) and on real experiments (results not in this repository).

## Steps

1. **Layout (D1).** A CSV pasted into the plugin: `well, role, sample_id, condition, dose, replicate_group,
   blank_group, planned_volume_uL, failed`. Roles: sample, blank (beads + buffer + detection reagent), unstained,
   sa_control, isotype_only, empty. Each sample is matched to its well by the FCS keyword `$SMNO`.
2. **Gates in checked steps (D2).** One gate set for the whole plate:
   1. template: the bead positions of a CytExpert experiment (gates imported from its .xit, or a template pasted as
      JSON);
   2. alignment: each bead's template polygon is moved, without changing its shape, onto its bead population in a
      reference well (default: the sample with the most events): in log10 space, the events inside the polygon
      enlarged 1.3 times around its area centroid, polygon centroid moved to their median, up to 5 times. A polygon
      with a vertex at or below 1 is not aligned (a note says so). Deterministic, so the
      Python reference reproduces it exactly. All gates are made in one undo step. Validation mode: the template
      polygons as they are. Gates are evaluated in linear space, exactly as the template;
   3. check: per bead, events and reporter median of the current gate against the template gate, in the reference
      well and over all wells; differences above a limit (default 10%, provisional), a missing gate or a value that
      cannot be computed are flagged `gate_check` (and `gate_missing`); the template statistics are read once per
      well and cached;
   4. review well by well in the plugin's bead plot (click a well in the plate map); a shifted gate is dragged onto its
      bead or aligned again in the shown well. Both change the shared gate, so every well keeps the same gate (flag
      `gate_corrected`);
   5. confirmation; any later gate change, including a well's own gate, removes it.
   A well with its own gate ("Adjust for this sample" in the app, against one gate set per plate) is flagged
   `own_gate` in the well and bead rows and in the plate map; "Use the plate gate again" removes it
   (`fs.clearSampleGate`).
3. **Reporter (D3).** Median of the reporter channel (default R660-APC-A) per bead population and well, from
   `fs.stat` (identical to the Statistics tables).
4. **Background (D6, D8).** Model A: the median minus the mean of the medians of the well's blank group (same bead);
   blank wells marked failed are left out.
   Model B (D7, optional, off by default; for PS/PE probes): offsets from unstained wells, then minus the mean of the
   REA and mIgG1 control beads in the same well; failed unstained wells are left out of the offsets.
5. **Normalization (D9).** Model A divided by the mean model A of CD9, CD63 and CD81 in the same well; not computed
   when one of them has no events or the mean is not positive.
6. **Replicates (D10).** Mean, SD (n - 1), CV and n of model A per replicate group and bead; n is the number of values
   used; only failed wells (empty gate, `failed` in the layout) are left out.
7. **No detection call (D12).** Values are continuous; a value near 0 is not evidence that a marker is absent (the
   beads-only blank does not remove EVs binding non-specifically to capture beads).
8. **Flags (D4, D5, D11, D14), which never change or remove a value.** Bead: `empty_gate`, `very_low_events` (< 20),
   `low_events` (20 to 49), `below_background`, `missing_blank`, `norm_not_computed`, `norm_low_events`,
   `failed_well`. Well: `not_loaded`, `early_stop` (`$VOL` < 95% of the planned volume; `$VOL` in nL),
   `low_singles` (< 10,000), `low_assignment` (< 50% of single beads in a bead gate), `negative_isotype`. Replicate
   group: `n_lt_2`, `replicate_cv` (> 30%). Blank group: `blank_cv` (> 30%), `blank_n_lt_3`. Plate: `order_trend`
   (Spearman of single beads vs acquisition order from `$DATE` / `$BTIM` below -0.5, wells with the role "empty" left
   out; `$BTIM` fractions: `.cc` hundredths, `:tt` sixtieths), `gates_template`, `own_gate`. Well: also `no_volume`
   (no `$VOL`, so `early_stop` cannot be checked) and `own_gate`. All limits are
   adjustable; those marked provisional in the specification are not yet validated.
9. **Export.** `summary`, `beads`, `wells`, `blanks`, `gates`, `run` as CSV or one Excel workbook; values unrounded.

## Why `fs.events` is used

- **Confidence interval of each median (D13):** a distribution-free 95% CI from order statistics (ranks from the
  binomial distribution with p = 0.5, summed in log space), which needs the event values. Deterministic, so the plugin
  and the Python reference agree exactly. No CI below 6 events.
- **Gate check (D2 step 3):** the template polygon's events and median are computed from the single-bead events
  (point in polygon in raw linear space), without adding the template gates as populations.

Medians themselves always come from `fs.stat`.

## Why `fs.autoGate` is not used

MACSPlex bead populations are small (often 20 to 200 events per bead and well) and lie close together. On real plates,
`fs.autoGate` around the template positions merged neighbouring beads (also with `tightness: 'tight'`); the comparison
was sent to the maintainer separately. The alignment above keeps the template's shapes, only moves them, and is
reproducible outside FlowState.

## Known limits

- The alignment corrects shifts up to about a third of a gate's width; a larger shift is corrected by dragging the gate.
- The plugin's gates carry linear scales (strict), so they do not depend on the axis scales. A gate edited in
  FlowState's own gating view may get the view's scales; the gate check shows such a change (`gate_corrected`).
- The .xit and the layout are opened with a plain file input in the plugin's page (the plugin API has no file dialog
  yet; API request `fs.openFile`). The .xit is read with `src/core/cytexpert.ts` (the CytExpert .xit import).

## References

- Wiklander OPB et al. Systematic methodological evaluation of a multiplex bead-based flow cytometry assay for
  detection of extracellular vesicle surface signatures. Front Immunol 2018;9:1326. doi:10.3389/fimmu.2018.01326
- Koliha N et al. A novel multiplex bead-based platform highlights the diversity of extracellular vesicles.
  J Extracell Vesicles 2016;5:29975. doi:10.3402/jev.v5.29975
- MACSPlex Exosome Kit, human: Miltenyi Biotec product documentation.
