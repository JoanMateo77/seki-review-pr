// Dashboard with actions without opening Claude Code: sh bin/tablero.sh [project] [port]
import { iniciarServidor } from './lib/servidor-web.mjs';

const [, , proyecto, puerto = '4317'] = process.argv;
const { url } = await iniciarServidor({ proyecto, puerto: Number(puerto) });
console.log(`Dashboard at ${url}\nCtrl+C to stop it.`);
