import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

// apply the saved light / dark choice before the first paint (no saved choice: follow the system)
try {
  const t = localStorage.getItem('fc-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage unavailable */
}

// No web fonts and no other network requests: the interface uses the system fonts (styles.css), figures the bundled
// font subsets (src/render/fonts).

createRoot(document.getElementById('root')!).render(<App />);
