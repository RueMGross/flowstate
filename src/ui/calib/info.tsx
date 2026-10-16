// Short "what is this?" texts for the calibration tools (start screen, Experiment > Setup).
import type { ReactNode } from 'react';

export const MESF_INFO: ReactNode = (
  <>
    <b>MESF / ERF calibration</b>
    <p>
      Converts fluorescence intensity into absolute units: MESF (molecules of equivalent soluble fluorochrome), ERF (equivalent reference
      fluorophores) or ABC (antibodies bound per cell).
    </p>
    <p>
      <i>Needs</i> a bead set with an assigned value per peak (e.g. Quantum MESF, rainbow beads with ERF values), measured with the same
      settings as the samples.
    </p>
    <p>
      <i>Useful</i> to compare instruments and days, to state a detection limit, and for nanoscale data (MIFlowCyt-EV).
    </p>
  </>
);

export const SIZE_INFO: ReactNode = (
  <>
    <b>Size calibration (Mie)</b>
    <p>
      Converts scatter intensity into scattering cross-section (nm²) and particle diameter, using Mie theory of light scattering by spheres
      (as in FCMPASS).
    </p>
    <p>
      <i>Needs</i> size beads of known diameter and refractive index (polystyrene or silica, e.g. nanoViS, ApogeeMix), measured with the
      same settings, and a model of your particles (e.g. EVs as core and membrane shell, refractive index about 1.38).
    </p>
    <p>
      <i>Useful</i> for EVs, viruses and other particles below about 1 µm. Not needed for cells.
    </p>
  </>
);
