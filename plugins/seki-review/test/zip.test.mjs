import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearZip, leerZip, reemplazarEntradas } from '../mcp/lib/zip.mjs';
import { conDescriptores } from './util/xlsx-fixture.mjs';

function centrales(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  const lista = [];
  let pos = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    lista.push(pos);
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return { eocd, lista };
}

function parchear(buf, indice, campo, valor, bytes = 2) {
  const copia = Buffer.from(buf);
  const pos = centrales(copia).lista[indice] + campo;
  if (bytes === 2) copia.writeUInt16LE(valor, pos);
  else copia.writeUInt32LE(valor, pos);
  return copia;
}

// Patches the declared uncompressed size in both the central and the local header.
function parchearTamano(buf, valor) {
  const copia = parchear(buf, 0, 24, valor, 4);
  copia.writeUInt32LE(valor, copia.readUInt32LE(centrales(copia).lista[0] + 42) + 22);
  return copia;
}

function codigoDe(fn) {
  try {
    fn();
  } catch (e) {
    return e.codigo;
  }
  return undefined;
}

const base = () => crearZip([
  { nombre: 'a.xml', datos: '<a>'.repeat(50) },
  { nombre: 'b.bin', datos: Buffer.from([1, 2, 3, 4]), comprimir: false },
]);

test('ida y vuelta con entradas almacenadas, comprimidas y nombre UTF-8', () => {
  const datos = Buffer.from('contenido '.repeat(100));
  const zip = crearZip([
    { nombre: 'hoja-ñ.xml', datos },
    { nombre: 'sin.txt', datos: 'plano', comprimir: false },
    { nombre: 'vacio.txt', datos: '' },
  ]);
  const mapa = leerZip(zip);
  assert.deepEqual([...mapa.keys()], ['hoja-ñ.xml', 'sin.txt', 'vacio.txt']);
  assert.ok(mapa.get('hoja-ñ.xml').equals(datos));
  assert.equal(mapa.get('sin.txt').toString(), 'plano');
  assert.equal(mapa.get('vacio.txt').length, 0);
  assert.ok(crearZip([{ nombre: 'x', datos: 'y' }]).equals(crearZip([{ nombre: 'x', datos: 'y' }])));
});

test('reemplazarEntradas conserva idénticos los bytes de entradas sin tocar', () => {
  const zip = crearZip([
    { nombre: 'a.xml', datos: 'uno '.repeat(80) },
    { nombre: 'b.xml', datos: 'dos '.repeat(80) },
    { nombre: 'c.bin', datos: 'tres', comprimir: false },
  ]);
  const nuevo = reemplazarEntradas(zip, new Map([['b.xml', Buffer.from('cambiado')], ['d.xml', Buffer.from('nuevo')]]));
  const mapa = leerZip(nuevo);
  assert.equal(mapa.get('b.xml').toString(), 'cambiado');
  assert.equal(mapa.get('d.xml').toString(), 'nuevo');
  assert.equal(mapa.get('a.xml').toString(), 'uno '.repeat(80));
  const trozo = (buf, nombre) => {
    const { lista } = centrales(buf);
    const offsets = lista.map((p) => buf.readUInt32LE(p + 42));
    const i = lista.findIndex((p) => buf.toString('utf8', p + 46, p + 46 + buf.readUInt16LE(p + 28)) === nombre);
    const fin = offsets.filter((o) => o > offsets[i]).sort((x, y) => x - y)[0] ?? buf.readUInt32LE(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16);
    return buf.subarray(offsets[i], fin);
  };
  for (const nombre of ['a.xml', 'c.bin']) assert.ok(trozo(zip, nombre).equals(trozo(nuevo, nombre)), nombre);
});

test('rechaza un archivo mayor que maxArchivo', () => {
  assert.equal(codigoDe(() => leerZip(base(), { maxArchivo: 10 })), 'ZIP_GRANDE');
});

test('rechaza más entradas que maxEntradas', () => {
  const muchas = Array.from({ length: 201 }, (_, i) => ({ nombre: `f${i}.txt`, datos: 'x' }));
  assert.equal(codigoDe(() => leerZip(crearZip(muchas))), 'ZIP_ENTRADAS');
  assert.equal(leerZip(crearZip(muchas.slice(0, 200))).size, 200);
});

test('rechaza entradas cifradas', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 0, 8, 0x0801))), 'ZIP_CIFRADO');
});

test('rechaza ZIP64 por tamaño 0xFFFFFFFF y por localizador', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 0, 20, 0xffffffff, 4))), 'ZIP64');
  const zip = base();
  const { eocd } = centrales(zip);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  assert.equal(codigoDe(() => leerZip(Buffer.concat([zip.subarray(0, eocd), loc, zip.subarray(eocd)]))), 'ZIP64');
});

test('rechaza nombres duplicados', () => {
  const zip = crearZip([{ nombre: 'a', datos: '1' }, { nombre: 'a', datos: '2' }]);
  assert.equal(codigoDe(() => leerZip(zip)), 'ZIP_DUPLICADO');
});

test('rechaza rutas peligrosas', () => {
  for (const nombre of ['../a', '/a', 'a\\b', 'C:a', 'x/../a']) {
    assert.equal(codigoDe(() => leerZip(crearZip([{ nombre, datos: 'x' }]))), 'ZIP_RUTA', nombre);
  }
});

test('acepta descriptores de datos con y sin firma y los valida contra el directorio central', () => {
  const esperado = leerZip(base());
  for (const firma of [true, false]) {
    const zip = conDescriptores(base(), { firma });
    const leido = leerZip(zip);
    assert.deepEqual([...leido.keys()], [...esperado.keys()]);
    for (const [k, v] of esperado) assert.deepEqual(leido.get(k), v);
    // crc, csize and usize of the first descriptor, right after the data.
    const c0 = centrales(zip).lista[0];
    const fin = zip.readUInt32LE(c0 + 42) + 30 + zip.readUInt16LE(c0 + 28) + zip.readUInt32LE(c0 + 20);
    for (const delta of [(firma ? 4 : 0), (firma ? 8 : 4), (firma ? 12 : 8)]) {
      const mal = Buffer.from(zip);
      mal.writeUInt32LE(mal.readUInt32LE(fin + delta) ^ 1, fin + delta);
      assert.equal(codigoDe(() => leerZip(mal)), 'ZIP_CORRUPTO', `firma=${firma} delta=${delta}`);
    }
  }
});

test('reemplazarEntradas con descriptores: copia las intactas con su descriptor y recodifica sin el bit 3', () => {
  for (const firma of [true, false]) {
    const zip = conDescriptores(base(), { firma });
    const nuevo = reemplazarEntradas(zip, new Map([['a.xml', '<z/>']]));
    const leido = leerZip(nuevo);
    assert.equal(leido.get('a.xml').toString(), '<z/>');
    assert.deepEqual(leido.get('b.bin'), Buffer.from([1, 2, 3, 4]));
    const [c0, c1] = centrales(nuevo).lista;
    assert.equal(nuevo.readUInt16LE(c0 + 8) & 0x8, 0);
    assert.equal(nuevo.readUInt16LE(c1 + 8) & 0x8, 0x8);
    assert.equal(nuevo.readUInt16LE(nuevo.readUInt32LE(c0 + 42) + 6) & 0x8, 0);
  }
});

test('rechaza descriptor con bit 3 solo en el directorio central', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 0, 8, 0x0808))), 'ZIP_CORRUPTO');
});

test('rechaza tamaño inflado distinto del declarado', () => {
  const zip = crearZip([{ nombre: 'a', datos: 'x'.repeat(100) }]);
  assert.equal(codigoDe(() => leerZip(parchearTamano(zip, 50))), 'ZIP_TAMANO');
  assert.equal(codigoDe(() => leerZip(parchearTamano(zip, 500))), 'ZIP_TAMANO');
  const almacenado = crearZip([{ nombre: 'a', datos: 'xyz', comprimir: false }]);
  assert.equal(codigoDe(() => leerZip(parchearTamano(almacenado, 2))), 'ZIP_TAMANO');
});

test('bomba de descompresión: tamaño declarado enorme o mentira sobre el tamaño real', () => {
  const bomba = crearZip([{ nombre: 'z', datos: Buffer.alloc(50 * 2 ** 20) }]);
  assert.ok(bomba.length < 5 * 2 ** 20);
  assert.equal(codigoDe(() => leerZip(bomba)), 'ZIP_GRANDE');
  assert.equal(codigoDe(() => leerZip(parchearTamano(bomba, 1000))), 'ZIP_TAMANO');
});

test('rechaza dos registros centrales con el mismo offset local', () => {
  const zip = crearZip([{ nombre: 'a', datos: 'uno' }, { nombre: 'b', datos: 'dos' }]);
  const { lista } = centrales(zip);
  const igual = parchear(zip, 1, 42, zip.readUInt32LE(lista[0] + 42), 4);
  assert.equal(codigoDe(() => leerZip(igual)), 'ZIP_SOLAPADO');
});

test('rechaza métodos de compresión no soportados', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 0, 10, 12))), 'ZIP_METODO');
});

test('rechaza archivos truncados', () => {
  const zip = base();
  assert.equal(codigoDe(() => leerZip(zip.subarray(0, zip.length - 10))), 'ZIP_CORRUPTO');
  assert.equal(codigoDe(() => leerZip(zip.subarray(0, 10))), 'ZIP_CORRUPTO');
});

test('rechaza CRC que no coincide', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 1, 16, 0x12345678, 4))), 'ZIP_CORRUPTO');
});

test('opciones undefined usan los valores por defecto y las inválidas se rechazan', () => {
  const grande = crearZip([{ nombre: 'z', datos: Buffer.alloc(30 * 2 ** 20) }]);
  assert.equal(codigoDe(() => leerZip(grande, { maxTotal: undefined, maxArchivo: undefined })), 'ZIP_GRANDE');
  assert.equal(codigoDe(() => leerZip(grande, { maxTotal: 2 ** 30 })), undefined);
  for (const malo of [NaN, Infinity, 0, -1, '5']) {
    assert.throws(() => leerZip(base(), { maxTotal: malo }), TypeError, String(malo));
    assert.throws(() => reemplazarEntradas(base(), new Map(), { maxArchivo: malo }), TypeError);
  }
});

test('rechaza bytes tras el EOCD y no se deja engañar por un EOCD falso dentro del comentario', () => {
  const zip = base();
  assert.equal(codigoDe(() => leerZip(Buffer.concat([zip, Buffer.from('xx')]))), 'ZIP_CORRUPTO');
  const falso = Buffer.alloc(22);
  falso.writeUInt32LE(0x06054b50, 0);
  const comentario = Buffer.concat([falso, Buffer.alloc(8)]);
  const real = Buffer.from(zip);
  real.writeUInt16LE(comentario.length, real.length - 2);
  assert.deepEqual([...leerZip(Buffer.concat([real, comentario])).keys()], ['a.xml', 'b.bin']);
});

function parchearLocal(buf, indice, campo, valor, bytes) {
  const copia = Buffer.from(buf);
  const pos = copia.readUInt32LE(centrales(copia).lista[indice] + 42) + campo;
  if (bytes === 1) copia[pos] = valor;
  else if (bytes === 2) copia.writeUInt16LE(valor, pos);
  else copia.writeUInt32LE(valor, pos);
  return copia;
}

test('rechaza discrepancias entre cabecera local y directorio central', () => {
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 30, 0x42, 1))), 'ZIP_CORRUPTO'); // name
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 8, 0, 2))), 'ZIP_CORRUPTO'); // method
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 14, 1, 4))), 'ZIP_CORRUPTO'); // crc
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 18, 1, 4))), 'ZIP_CORRUPTO'); // csize
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 22, 1, 4))), 'ZIP_CORRUPTO'); // usize
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 6, 0x0801, 2))), 'ZIP_CIFRADO');
  assert.equal(codigoDe(() => leerZip(parchearLocal(base(), 0, 6, 0x0808, 2))), 'ZIP_CORRUPTO');
});

test('reemplazarEntradas rechaza datos de tipo inválido con TypeError', () => {
  assert.throws(() => reemplazarEntradas(base(), new Map([['a.xml', 42]])), TypeError);
});

test('reemplazarEntradas conserva los bytes del nombre y el indicador de codificación', () => {
  const zip = crearZip([{ nombre: 'a.txt', datos: 'uno' }]);
  const cp437 = Buffer.from(zip);
  cp437.writeUInt16LE(0, 6); // local flags: no UTF-8
  cp437.writeUInt16LE(0, centrales(cp437).lista[0] + 8);
  const nuevo = reemplazarEntradas(cp437, new Map([['a.txt', Buffer.from('dos')]]));
  assert.equal(nuevo.readUInt16LE(6), 0);
  assert.equal(nuevo.readUInt16LE(centrales(nuevo).lista[0] + 8), 0);
  assert.equal(leerZip(nuevo).get('a.txt').toString(), 'dos');
  assert.equal(reemplazarEntradas(zip, new Map([['a.txt', 'x']])).readUInt16LE(6), 0x0800);
});
