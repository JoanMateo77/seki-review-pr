import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargarPlantillas, globARegex, itemsDeterministas, itemsIa, seleccionarPlantillas, validarPlantilla } from '../mcp/lib/plantillas.mjs';

const temporales = [];
afterEach(() => {
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dirTemporal = () => {
  const d = mkdtempSync(join(tmpdir(), 'seki-plant-'));
  temporales.push(d);
  return d;
};
const item = (id, extra = {}) => ({ id, pregunta: 'Q?', evidencia: 'E', reglas: [], siFalla: { etiqueta: 'issue', bloqueante: true }, ...extra });
const valida = (extra = {}) => ({ id: 'mia', version: 1, titulo: 'Mine', idioma: 'en', siempre: false, aplicaA: ['src/**'], excluir: [], items: [item('A1')], ...extra });

test('globARegex matches ** across directories and zero directories', () => {
  const g = globARegex('src/**/x.ts');
  assert.ok(g.test('src/x.ts'));
  assert.ok(g.test('src/a/b/x.ts'));
  assert.ok(!g.test('src/a/b/y.ts'));
  assert.ok(!globARegex('*.ts').test('a/b.ts'));
  assert.ok(globARegex('*.ts').test('b.ts'));
  assert.ok(globARegex('a{b}').test('a{b}'));
  assert.ok(!globARegex('a{b}').test('ab'));
  assert.ok(globARegex('a?c.ts').test('abc.ts'));
  assert.ok(!globARegex('a?c.ts').test('a/c.ts'));
  assert.ok(!globARegex('a.ts').test('aXts'));
  assert.ok(!globARegex('**/pago*').test('x/Pago1'));
  assert.ok(globARegex('**/*pago*').test('src/mi-pago.ts'));
});

test('the base templates load and validate', () => {
  const { plantillas, invalidas } = cargarPlantillas({});
  assert.deepEqual(plantillas.map((t) => t.id).sort(), ['ligera', 'owasp-web', 'pci-dss']);
  assert.equal(plantillas[0].id, 'ligera');
  assert.equal(plantillas.find((t) => t.id === 'ligera').siempre, true);
  assert.deepEqual(invalidas, []);
  const ligera = plantillas.find((t) => t.id === 'ligera');
  assert.deepEqual(itemsDeterministas(ligera).map((i) => [i.id, i.reglas]), [['L4-despliegue', ['rutas-en-otros-repos']], ['L7-tipos', ['as-any', 'tipo-any']]]);
  assert.ok(itemsIa(ligera).length > 0);
  assert.ok(!ligera.items.some((i) => i.id === 'L6-praise'));
  assert.equal(itemsIa(ligera).length + itemsDeterministas(ligera).length, ligera.items.length);
});

test('a project template with the same id replaces the base one, a new id is added', () => {
  const dir = dirTemporal();
  writeFileSync(join(dir, 'owasp-web.json'), JSON.stringify(valida({ id: 'owasp-web', version: 9 })));
  writeFileSync(join(dir, 'extra.json'), JSON.stringify(valida({ id: 'extra' })));
  writeFileSync(join(dir, 'notas.txt'), 'ignored');
  const { plantillas, invalidas } = cargarPlantillas({ plantillas: dir });
  assert.equal(plantillas.find((t) => t.id === 'owasp-web').version, 9);
  assert.deepEqual(plantillas.map((t) => t.id), ['ligera', 'extra', 'owasp-web', 'pci-dss']);
  assert.deepEqual(invalidas, []);
});

test('a missing project directory means no project templates and no error', () => {
  const { plantillas, invalidas } = cargarPlantillas({ plantillas: join(dirTemporal(), 'nope') });
  assert.equal(plantillas.length, 3);
  assert.deepEqual(invalidas, []);
});

test('an invalid project template is skipped and reported', () => {
  const dir = dirTemporal();
  writeFileSync(join(dir, 'roto.json'), '{ not json');
  writeFileSync(join(dir, 'vacia.json'), JSON.stringify(valida({ id: 'vacia', items: [] })));
  writeFileSync(join(dir, 'enorme.json'), JSON.stringify(valida({ id: 'enorme', items: Array.from({ length: 31 }, (_, i) => item(`I${i}`)) })));
  const previo = console.error;
  const avisos = [];
  console.error = (m) => avisos.push(m);
  let r;
  try {
    r = cargarPlantillas({ plantillas: dir });
  } finally {
    console.error = previo;
  }
  assert.equal(r.invalidas.length, 3);
  for (const i of r.invalidas) assert.ok(i.archivo && i.motivo);
  assert.deepEqual(r.plantillas.map((t) => t.id), ['ligera', 'owasp-web', 'pci-dss']);
  assert.equal(avisos.length, 3);
});

test('a file larger than 64 KB is skipped and reported', () => {
  const dir = dirTemporal();
  writeFileSync(join(dir, 'grande.json'), JSON.stringify(valida({ id: 'grande', titulo: 'x'.repeat(70000) })));
  const previo = console.error;
  console.error = () => {};
  let r;
  try {
    r = cargarPlantillas({ plantillas: dir });
  } finally {
    console.error = previo;
  }
  assert.equal(r.invalidas.length, 1);
  assert.match(r.invalidas[0].motivo, /64 KB/);
});

test('validarPlantilla rejects each malformed field with a reason', () => {
  assert.equal(validarPlantilla(valida()).ok, true);
  const malas = [
    null,
    [],
    valida({ id: 'Bad Id' }),
    valida({ version: 0 }),
    valida({ version: 1.5 }),
    valida({ titulo: '' }),
    valida({ idioma: 'fr' }),
    valida({ siempre: 'yes' }),
    valida({ aplicaA: 'src/**' }),
    valida({ aplicaA: Array(41).fill('a') }),
    valida({ excluir: ['x'.repeat(201)] }),
    valida({ items: [item('A'), item('A')] }),
    valida({ items: [item('A', { pregunta: '' })] }),
    valida({ items: [item('A', { reglas: 'x' })] }),
    valida({ items: [item('A', { siFalla: { etiqueta: 'praise', bloqueante: false } })] }),
    valida({ items: [item('A', { siFalla: { etiqueta: 'issue', bloqueante: 'si' } })] }),
    valida({ items: [item('A', { siFalla: { etiqueta: 'issue', bloqueante: true, tema: 'Sec Urity' } })] }),
  ];
  for (const m of malas) {
    const r = validarPlantilla(m);
    assert.equal(r.ok, false, JSON.stringify(m)?.slice(0, 80));
    assert.ok(r.motivo.length > 0);
  }
  const ok = validarPlantilla({ id: 'min', version: 2, titulo: 'T', items: [item('A', { siFalla: { etiqueta: 'nitpick', bloqueante: false, tema: 'security' } })] });
  assert.equal(ok.ok, true);
  assert.equal(ok.plantilla.idioma, 'en');
  assert.equal(ok.plantilla.siempre, false);
  assert.deepEqual(ok.plantilla.aplicaA, []);
  assert.deepEqual(ok.plantilla.excluir, []);
});

test('selection reports the first matching file and the files covered only by the base template', () => {
  const { plantillas } = cargarPlantillas({});
  const s = seleccionarPlantillas(plantillas, ['src/routes/a.ts', 'src/routes/__tests__/a.spec.ts']);
  const owasp = s.activas.find((t) => t.id === 'owasp-web');
  assert.equal(owasp.motivo.archivo, 'src/routes/a.ts');
  assert.ok(owasp.motivo.glob);
  assert.equal(s.activas.find((t) => t.id === 'ligera').motivo, 'siempre');
  assert.deepEqual(s.omitidas.map((t) => t.id), ['pci-dss']);
  assert.deepEqual(s.sinPlantilla, ['src/routes/__tests__/a.spec.ts']);
  assert.deepEqual(Object.keys(owasp).sort(), ['id', 'motivo', 'titulo', 'version']);
});

test('payment-like paths activate pci-dss in both cases', () => {
  const { plantillas } = cargarPlantillas({});
  for (const ruta of ['lib/PagoService.ts', 'lib/pagos.ts', 'src/PaymentRoutes.ts', 'src/checkout.ts', 'src/Merchant.ts', 'src/transaccion.ts']) {
    assert.ok(seleccionarPlantillas(plantillas, [ruta]).activas.some((t) => t.id === 'pci-dss'), ruta);
  }
  assert.ok(!seleccionarPlantillas(plantillas, ['README.md']).activas.some((t) => t.id === 'pci-dss'));
});
