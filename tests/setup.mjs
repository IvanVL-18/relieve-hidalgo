/** Pruebas con el ejecutor de Node: permite importar los .ts del visor sin extensión (como los resuelve Vite). */
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
