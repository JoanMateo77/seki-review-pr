import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearZip, leerZip, reemplazarEntradas } from '../mcp/lib/zip.mjs';

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

test('rechaza descriptores de datos', () => {
  assert.equal(codigoDe(() => leerZip(parchear(base(), 0, 8, 0x0808))), 'ZIP_DESCRIPTOR');
});

test('rechaza tamaño inflado distinto del declarado', () => {
  const zip = crearZip([{ nombre: 'a', datos: 'x'.repeat(100) }]);
  assert.equal(codigoDe(() => leerZip(parchear(zip, 0, 24, 50, 4))), 'ZIP_TAMANO');
  assert.equal(codigoDe(() => leerZip(parchear(zip, 0, 24, 500, 4))), 'ZIP_TAMANO');
  const almacenado = crearZip([{ nombre: 'a', datos: 'xyz', comprimir: false }]);
  assert.equal(codigoDe(() => leerZip(parchear(almacenado, 0, 24, 2, 4))), 'ZIP_TAMANO');
});

test('bomba de descompresión: tamaño declarado enorme o mentira sobre el tamaño real', () => {
  const bomba = crearZip([{ nombre: 'z', datos: Buffer.alloc(50 * 2 ** 20) }]);
  assert.ok(bomba.length < 5 * 2 ** 20);
  assert.equal(codigoDe(() => leerZip(bomba)), 'ZIP_GRANDE');
  assert.equal(codigoDe(() => leerZip(parchear(bomba, 0, 24, 1000, 4))), 'ZIP_TAMANO');
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
