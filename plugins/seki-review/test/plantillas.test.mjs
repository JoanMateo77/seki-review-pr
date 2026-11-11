import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as leerArchivo } from 'node:fs';
import { archivosDePlantilla, cargarPlantillas, globARegex, itemsDeterministas, itemsIa, seleccionarPlantillas, validarPlantilla } from '../mcp/lib/plantillas.mjs';

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
// The bundled templates, sorted by id; `ligera` is the only one that always applies.
const BASE = ['aislamiento-datos', 'cadena-suministro', 'cliente-navegador', 'disponibilidad', 'ia-llm', 'ligera', 'mensajeria-webhooks', 'nube-despliegue', 'owasp-web', 'pci-dss', 'sesion-identidad'];
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
  assert.deepEqual(plantillas.map((t) => t.id).sort(), BASE);
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
  assert.deepEqual(plantillas.map((t) => t.id), ['ligera', ...['extra', ...BASE.filter((id) => id !== 'ligera')].sort()]);
  assert.deepEqual(invalidas, []);
});

test('a missing project directory keeps the base templates and is reported as invalid', (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const dir = join(dirTemporal(), 'nope');
  const { plantillas, invalidas } = cargarPlantillas({ plantillas: dir });
  assert.equal(plantillas.length, BASE.length);
  assert.deepEqual(invalidas, [{ archivo: dir, motivo: 'the project template folder does not exist' }]);
  assert.equal(avisos.mock.calls.length, 1);
  assert.deepEqual(cargarPlantillas({}).invalidas, []);
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
  assert.deepEqual(r.plantillas.map((t) => t.id), ['ligera', ...BASE.filter((id) => id !== 'ligera')]);
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
    valida({ id: 5 }),
    valida({ id: ['mia'] }),
    valida({ items: [item(7)] }),
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
  assert.deepEqual(s.omitidas.map((t) => t.id), BASE.filter((id) => !['ligera', 'owasp-web'].includes(id)));
  assert.deepEqual(s.sinPlantilla, ['src/routes/__tests__/a.spec.ts']);
  assert.deepEqual(Object.keys(owasp).sort(), ['id', 'motivo', 'titulo', 'version']);
});

test('payment-like paths activate pci-dss in both cases', () => {
  const { plantillas } = cargarPlantillas({});
  for (const ruta of ['lib/PagoService.ts', 'lib/pagos.ts', 'src/PaymentRoutes.ts', 'src/checkout.ts', 'src/Merchant.ts', 'src/transaccion.ts', 'src/transaction.ts', 'src/TransactionService.ts', 'src/pagos/x.ts', 'src/Payment/x.ts', 'a/merchants/b/c.ts', 'src/Checkout/x.ts', 'src/transactions/x.ts']) {
    assert.ok(seleccionarPlantillas(plantillas, [ruta]).activas.some((t) => t.id === 'pci-dss'), ruta);
  }
  assert.ok(!seleccionarPlantillas(plantillas, ['README.md']).activas.some((t) => t.id === 'pci-dss'));
});

test('archivosDePlantilla gives the changed paths that activate a template, all of them for an always template', () => {
  const rutas = ['src/pagos/a.ts', 'src/pagos/a.spec.ts', 'docs/x.md'];
  const base = { id: 't', version: 1, titulo: 'T', idioma: 'en', excluir: [], items: [] };
  assert.deepEqual(archivosDePlantilla({ ...base, siempre: false, aplicaA: ['src/**'], excluir: ['**/*.spec.ts'] }, rutas), ['src/pagos/a.ts']);
  assert.deepEqual(archivosDePlantilla({ ...base, siempre: false, aplicaA: ['api/**'] }, rutas), []);
  assert.deepEqual(archivosDePlantilla({ ...base, siempre: true, aplicaA: ['api/**'] }, rutas), rutas);
});

test('cubre is optional and accepts only a list of known Ultra lens names', () => {
  const ok = validarPlantilla(valida({ cubre: ['seguridad'] }));
  assert.deepEqual([ok.ok, ok.plantilla.cubre], [true, ['seguridad']]);
  assert.deepEqual(validarPlantilla(valida()).plantilla.cubre, []);
  for (const mala of ['seguridad', [1], ['security'], ['seguridad', 'seguridad'], [{}]]) {
    const r = validarPlantilla(valida({ cubre: mala }));
    assert.equal(r.ok, false, JSON.stringify(mala));
    assert.match(r.motivo, /cubre/);
  }
});

test('owasp-web and pci-dss declare that they cover the security lens', () => {
  for (const id of ['owasp-web', 'pci-dss']) {
    const t = JSON.parse(leerArchivo(new URL(`../plantillas/${id}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(t.cubre, ['seguridad'], id);
    assert.deepEqual(validarPlantilla(t).plantilla.cubre, ['seguridad'], id);
  }
});

// Paths an ordinary PR changes that none of the audit-derived templates should claim.
const ORDINARIAS = ['src/controllers/OrderController.ts', 'README.md', 'src/utils/format.ts'];
const AUDITORIA = {
  'sesion-identidad': { prefijo: 'S', activan: ['src/auth/index.ts', 'src/middleware/authMiddleware.ts', 'lib/SessionStore.js', 'src/sesiones/crear.ts', 'src/utils/jwt.ts', 'src/sso/saml.ts', 'src/services/PasswordReset.ts', 'src/mfa/verificar.ts', 'src/routes/apiKeys.ts', 'src/otp.ts'], excluida: 'src/auth/__tests__/login.spec.ts', noActivan: ['src/processors/order.ts', 'docs/footprint.md'] },
  'cliente-navegador': { prefijo: 'C', activan: ['src/components/Button.tsx', 'web/src/App.jsx', 'src/views/Home.vue', 'src/routes/+page.svelte', 'public/js/checkout.js', 'static/main.js', 'src/assets/vendor/widget.js', 'views/index.html'], excluida: 'src/components/Button.test.tsx', noActivan: ['src/server/app.js'] },
  'aislamiento-datos': { prefijo: 'D', activan: ['src/services/exportOrders.ts', 'src/reports/monthly.ts', 'src/ReporteVentas.ts', 'src/cache/redis.ts', 'src/search/index.ts', 'db/migrations/20260101-add-tenant.js', 'src/jobs/purgeDeleted.ts', 'src/descargas/factura.ts', 'scripts/backup.sh'], excluida: 'src/reports/monthly.test.ts', noActivan: [] },
  'cadena-suministro': { prefijo: 'K', activan: ['package.json', 'packages/api/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc', 'Dockerfile', 'docker/Dockerfile.prod', '.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', 'scripts/publish.sh'], excluida: 'src/__tests__/package.json', noActivan: ['src/services/publisher.ts', 'src/payments/releaseFunds.ts'] },
  'mensajeria-webhooks': { prefijo: 'M', activan: ['src/webhooks/stripe.ts', 'src/routes/paymentCallback.ts', 'src/queue/consumer.ts', 'src/colas/pagos.ts', 'src/OrderSubscriber.ts', 'workers/email.js', 'src/kafka/producer.ts', 'src/sqs.ts', 'lib/amqp.js', 'proto/orders.proto'], excluida: 'src/webhooks/stripe.spec.ts', noActivan: ['src/colaboradores/lista.ts', 'src/chocolate.ts'] },
  'disponibilidad': { prefijo: 'R', activan: ['src/routes/upload.ts', 'src/cargas/csv.ts', 'src/services/CsvImport.ts', 'src/importers/clientes.ts', 'src/jobs/nightly.ts', 'src/cron/limpieza.ts', 'src/BulkUpdate.ts', 'src/cargaMasiva.ts', 'src/parsers/xml.ts', 'src/scheduler.ts', 'src/streamReport.ts'], excluida: 'src/jobs/nightly.test.ts', noActivan: ['src/services/calcularImporte.ts', 'src/recargas/saldo.ts'] },
  'nube-despliegue': { prefijo: 'N', activan: ['infra/main.tf', 'infra/prod.tfvars', 'deploy/k8s/deployment.yaml', 'charts/api/values.yaml', 'serverless.yml', 'docker-compose.prod.yaml', 'cloudformation/stack.json', 'infra/main.bicep', 'wrangler.toml', 'nginx/default.conf', 'ops/ingress.yaml'], excluida: 'infra/__tests__/main.tf', noActivan: ['src/infra/database.ts'] },
  'ia-llm': { prefijo: 'A', activan: ['src/llm/client.ts', 'src/prompts/resumen.md', 'src/services/openaiClient.ts', 'lib/anthropic.ts', 'src/ClaudeService.ts', 'src/gemini.ts', 'src/agents/planner.ts', 'src/embeddings.ts', 'src/rag/retriever.ts', 'tools/mcp/server.mjs'], excluida: 'src/llm/client.test.ts', noActivan: ['src/storage/average.ts', 'CLAUDE.md'] },
};

test('every bundled template file loads and validates, with no invalid file', () => {
  const { plantillas, invalidas } = cargarPlantillas({});
  assert.deepEqual(plantillas.map((t) => t.id).sort(), BASE);
  assert.deepEqual(invalidas, []);
});

for (const [id, caso] of Object.entries(AUDITORIA)) {
  test(`${id}: 4 to 6 items with the ${caso.prefijo} prefix, no cubre, and its paths activate it`, () => {
    const crudo = JSON.parse(leerArchivo(new URL(`../plantillas/${id}.json`, import.meta.url), 'utf8'));
    assert.equal(crudo.cubre, undefined, 'a narrow template must not switch off the Ultra security lens');
    assert.deepEqual([crudo.idioma, crudo.version, crudo.siempre], ['en', 1, false]);
    assert.deepEqual(crudo.excluir, ['**/__tests__/**', '**/*.spec.*', '**/*.test.*']);
    const r = validarPlantilla(crudo);
    assert.equal(r.ok, true, r.motivo);
    const t = r.plantilla;
    assert.ok(t.items.length >= 4 && t.items.length <= 6, `${t.items.length} items`);
    for (const it of t.items) assert.match(it.id, new RegExp(`^${caso.prefijo}\\d-[a-z-]+$`));
    if (id !== 'disponibilidad') assert.ok(t.items.some((it) => it.siFalla.bloqueante), 'at least one blocking item');
    for (const it of t.items) if (it.siFalla.bloqueante) assert.equal(it.siFalla.etiqueta, 'issue', it.id);
    const { plantillas } = cargarPlantillas({});
    const activa = (ruta) => seleccionarPlantillas(plantillas, [ruta]).activas.some((a) => a.id === id);
    assert.ok(caso.activan.length >= 3);
    for (const ruta of caso.activan) assert.ok(activa(ruta), `${ruta} should activate ${id}`);
    for (const ruta of [...ORDINARIAS, caso.excluida, ...caso.noActivan]) assert.ok(!activa(ruta), `${ruta} should not activate ${id}`);
  });
}

test('a PR that changes only README.md selects only the light baseline', () => {
  const { plantillas } = cargarPlantillas({});
  assert.deepEqual(seleccionarPlantillas(plantillas, ['README.md']).activas.map((a) => a.id), ['ligera']);
});

test('the attribution of the audit-derived templates names the source commit and keeps the MIT copyright line', () => {
  const aviso = leerArchivo(new URL('../plantillas/NOTICE.md', import.meta.url), 'utf8');
  assert.match(aviso, /c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/);
  assert.match(aviso, /github\.com\/cloudflare\/security-audit-skill/);
  assert.match(aviso, /Copyright \(c\) 2025-2026 Cloudflare, Inc\./);
  assert.match(aviso, /THE SOFTWARE IS PROVIDED "AS IS"/);
  for (const id of Object.keys(AUDITORIA)) assert.ok(aviso.includes(`\`${id}\``), id);
});

test('the security, verification and template prompts require a crossed boundary and a concrete result', () => {
  const prompt = (n) => leerArchivo(new URL(`../mcp/prompts/${n}.md`, import.meta.url), 'utf8');
  const seguridad = prompt('ultra-seguridad');
  assert.match(seguridad, /lower-trust actor/);
  assert.match(seguridad, /self-impact/);
  assert.match(seguridad, /Without all four it is not a finding, except a hardening note, which is only `baja`/);
  assert.match(seguridad, /whoever can read that place/);
  assert.match(seguridad, /duplicate charge or refund/);
  assert.match(seguridad, /assuming the deployment, proxy or provider is misconfigured/);
  assert.match(seguridad, /name the external fact to confirm/);
  assert.match(seguridad, /cannot exceed the result/);
  const verificar = prompt('ultra-verificar');
  assert.match(verificar, /disprove/);
  assert.match(verificar, /outside the repository[^\n]*PLAUSIBLE/);
  assert.match(verificar, /own resources[^\n]*REJECTED|REJECTED[^\n]*own resources/);
  const plantilla = prompt('plantilla');
  assert.match(plantilla, /boundary can be crossed/);
  assert.match(plantilla, /outside the available code[^\n]*`no_verificable`/);
  assert.match(plantilla, /redundant[^\n]*`cumple`/);
  const aviso = leerArchivo(new URL('../plantillas/NOTICE.md', import.meta.url), 'utf8');
  for (const n of ['ultra-seguridad.md', 'ultra-verificar.md', 'plantilla.md']) assert.ok(aviso.includes(n), n);
});
