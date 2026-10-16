// Calibration view: MESF / ERF fluorescence calibration and Mie light-scatter size calibration.
import { useLayoutEffect, useRef } from 'react';
import { calibTools } from '../core/model';
import { useStore } from '../state/store';
import { MesfPage } from './calib/MesfPage';
import { SizePage } from './calib/SizePage';
import { Icon } from './icons';
import { Seg } from './widgets';
import './calib.css';

export function CalibrationView() {
  const want = useStore((s) => s.ui.calibMode) ?? 'mesf';
  const showMesf = useStore((s) => calibTools(s.ws).mesf);
  const showSize = useStore((s) => calibTools(s.ws).size);
  // the experiment setup may hide one of the two (see Workspace.setup)
  const mode = want === 'size' ? (showSize || !showMesf ? 'size' : 'mesf') : showMesf || !showSize ? 'mesf' : 'size';
  const st = useStore.getState();
  // each page opens at its top (the two pages share the scroll container: the size page's Create button is far down)
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [mode]);
  return (
    <div ref={ref} className="doc-view cal-view">
      <div className="cal-head">
        <Seg
          value={mode}
          options={(
            [
            {
              value: 'mesf',
              label: (
                <>
                  <Icon.beads /> MESF / ERF
                </>
              ),
              title: 'Fluorescence intensity calibration with reference beads',
            },
            {
              value: 'size',
              label: (
                <>
                  <Icon.ruler /> Size (Mie)
                </>
              ),
              title: 'Light-scatter calibration in nm² and diameter (Mie model as in FCMPASS, Welsh et al. 2020)',
            },
          ] as const
          ).filter((o) => (o.value === 'mesf' ? showMesf : showSize) || (!showMesf && !showSize))}
          onChange={(v) => st.setUI({ calibMode: v })}
        />
        <span className="hint">
          {mode === 'mesf'
            ? 'Bead medians and certificate values give a regression from MFI to MESF / ERF; it is applied to your samples as a new channel.'
            : 'Reference beads fit the scatter detector with Mie theory; a particle model then turns scatter into diameter (nm) and cross section (nm²).'}
        </span>
      </div>
      <div className="cal-col">{mode === 'size' ? <SizePage /> : <MesfPage />}</div>
    </div>
  );
}
