// Tablero con acciones sin abrir Claude Code: sh bin/tablero.sh [proyecto] [puerto]
import { iniciarServidor } from './lib/servidor-web.mjs';

const [, , proyecto, puerto = '4317'] = process.argv;
const { url } = await iniciarServidor({ proyecto, puerto: Number(puerto) });
console.log(`Tablero en ${url}\nCtrl+C para detenerlo.`);
