import './styles.css';
import './editor.css';
import { App } from './app';

const root = document.getElementById('app')!;
const app = new App(root);
// Handy for debugging from DevTools
(window as unknown as { pixelline_app: App }).pixelline_app = app;
