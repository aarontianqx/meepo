import { createRoot } from 'react-dom/client';

import { App } from './App';
import { initTheme } from './app/theme';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/features.css';

initTheme();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
