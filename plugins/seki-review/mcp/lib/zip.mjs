import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCALIZADOR = 0x07064b50;
const DOS_FECHA = 0x0021; // 1980-01-01, fixed so output is deterministic
const DOS_HORA = 0;
const FLAG_UTF8 = 0x0800;
const LIMITES = { maxEntradas: 200, maxTotal: 20 * 2 ** 20, maxArchivo: 5 * 2 ** 20 };

function fallar(codigo, mensaje) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  throw e;
}

function aBuffer(datos) {
  return Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'utf8');
}

function codificar(nombre, datos, comprimir) {
  const nom = Buffer.from(nombre, 'utf8');
  const crudo = aBuffer(datos);
  const metodo = comprimir === false ? 0 : 8;
  const cuerpo = metodo === 8 ? deflateRawSync(crudo) : crudo;
  const local = Buffer.alloc(30 + nom.length);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(metodo, 8);
  local.writeUInt16LE(DOS_HORA, 10);
  local.writeUInt16LE(DOS_FECHA, 12);
  local.writeUInt32LE(crc32(crudo) >>> 0, 14);
  local.writeUInt32LE(cuerpo.length, 18);
  local.writeUInt32LE(crudo.length, 22);
  local.writeUInt16LE(nom.length, 26);
  nom.copy(local, 30);
  const central = Buffer.alloc(46 + nom.length);
  central.writeUInt32LE(SIG_CENTRAL, 0);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30); // version needed .. name length, same layout
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  nom.copy(central, 46);
  return { local, cuerpo, central };
}

function ensamblar(piezas) {
  const partes = [];
  const centrales = [];
  let offset = 0;
  for (const p of piezas) {
    const central = Buffer.from(p.central);
    central.writeUInt32LE(offset, 42);
    centrales.push(central);
    partes.push(p.local, p.cuerpo);
    offset += p.local.length + p.cuerpo.length;
  }
  const dir = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(piezas.length, 8);
  eocd.writeUInt16LE(piezas.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, dir, eocd]);
}

export function crearZip(entradas) {
  return ensamblar(entradas.map((e) => codificar(e.nombre, e.datos, e.comprimir)));
}

function rutaInvalida(nombre) {
  if (nombre === '' || nombre.includes('\0') || nombre.includes('\\') || nombre.startsWith('/') || /^[A-Za-z]:/.test(nombre)) return true;
  return nombre.split('/').some((s) => s === '..');
}

// Structural parse only: no inflation. Trusts the central directory.
function analizar(buf, opciones = {}) {
  const lim = { ...LIMITES, ...opciones };
  if (!Buffer.isBuffer(buf)) fallar('ZIP_CORRUPTO', 'Archive is not a buffer');
  if (buf.length > lim.maxArchivo) fallar('ZIP_GRANDE', 'Archive exceeds the size limit');
  if (buf.length < 22) fallar('ZIP_CORRUPTO', 'Archive is truncated');
  let eocd = -1;
  const minimo = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minimo; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fallar('ZIP_CORRUPTO', 'End of central directory not found');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCALIZADOR) fallar('ZIP64', 'ZIP64 archives are not supported');
  const disco = buf.readUInt16LE(eocd + 4);
  const discoDir = buf.readUInt16LE(eocd + 6);
  const nDisco = buf.readUInt16LE(eocd + 8);
  const n = buf.readUInt16LE(eocd + 10);
  const tamDir = buf.readUInt32LE(eocd + 12);
  const offDir = buf.readUInt32LE(eocd + 16);
  if (n === 0xffff || tamDir === 0xffffffff || offDir === 0xffffffff) fallar('ZIP64', 'ZIP64 archives are not supported');
  if (disco !== 0 || discoDir !== 0 || nDisco !== n) fallar('ZIP_CORRUPTO', 'Multi-disk archives are not supported');
  if (n > lim.maxEntradas) fallar('ZIP_ENTRADAS', 'Archive has too many entries');
  if (offDir + tamDir > eocd) fallar('ZIP_CORRUPTO', 'Central directory out of bounds');

  const entradas = [];
  const vistos = new Set();
  let pos = offDir;
  let totalDeclarado = 0;
  for (let i = 0; i < n; i++) {
    if (pos + 46 > offDir + tamDir || buf.readUInt32LE(pos) !== SIG_CENTRAL) fallar('ZIP_CORRUPTO', 'Invalid central directory record');
    const flags = buf.readUInt16LE(pos + 8);
    const metodo = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const largo = 46 + nlen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    if (pos + largo > offDir + tamDir) fallar('ZIP_CORRUPTO', 'Invalid central directory record');
    if (flags & 0x1) fallar('ZIP_CIFRADO', 'Encrypted entries are not supported');
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) fallar('ZIP64', 'ZIP64 archives are not supported');
    if (flags & 0x8) fallar('ZIP_DESCRIPTOR', 'Data descriptors are not supported');
    if (metodo !== 0 && metodo !== 8) fallar('ZIP_METODO', 'Unsupported compression method');
    const nombreBuf = buf.subarray(pos + 46, pos + 46 + nlen);
    const nombre = nombreBuf.toString('utf8');
    if (rutaInvalida(nombre)) fallar('ZIP_RUTA', 'Invalid entry path');
    if (vistos.has(nombre)) fallar('ZIP_DUPLICADO', 'Duplicate entry name');
    vistos.add(nombre);
    totalDeclarado += usize;
    if (usize > lim.maxTotal || totalDeclarado > lim.maxTotal) fallar('ZIP_GRANDE', 'Declared uncompressed size exceeds the limit');
    if (offset + 30 > offDir || buf.readUInt32LE(offset) !== SIG_LOCAL) fallar('ZIP_CORRUPTO', 'Invalid local header');
    const inicio = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const fin = inicio + csize;
    if (fin > offDir) fallar('ZIP_CORRUPTO', 'Entry data out of bounds');
    entradas.push({ nombre, nombreBuf, flags, metodo, crc, csize, usize, offset, inicio, fin, pos, largo });
    pos += largo;
  }
  const porOffset = [...entradas].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < porOffset.length; i++) {
    if (porOffset[i].offset < porOffset[i - 1].fin) fallar('ZIP_SOLAPADO', 'Overlapping entries');
  }
  for (const e of entradas) {
    const localFlags = buf.readUInt16LE(e.offset + 6);
    if ((localFlags & 0x9) !== 0) fallar(localFlags & 0x1 ? 'ZIP_CIFRADO' : 'ZIP_DESCRIPTOR', 'Local header flags are not supported');
    const nlen = buf.readUInt16LE(e.offset + 26);
    if (buf.readUInt16LE(e.offset + 8) !== e.metodo || !buf.subarray(e.offset + 30, e.offset + 30 + nlen).equals(e.nombreBuf)) {
      fallar('ZIP_CORRUPTO', 'Local header does not match the central directory');
    }
  }
  return { entradas, offDir, eocd };
}

export function leerZip(buf, opciones = {}) {
  const lim = { ...LIMITES, ...opciones };
  const { entradas } = analizar(buf, lim);
  const salida = new Map();
  let total = 0;
  for (const e of entradas) {
    const cuerpo = buf.subarray(e.inicio, e.fin);
    let datos;
    if (e.metodo === 0) {
      if (e.csize !== e.usize) fallar('ZIP_TAMANO', 'Entry size does not match the declared size');
      datos = Buffer.from(cuerpo);
    } else {
      try {
        datos = inflateRawSync(cuerpo, { maxOutputLength: Math.max(e.usize, 1) });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') fallar('ZIP_TAMANO', 'Entry size does not match the declared size');
        fallar('ZIP_CORRUPTO', 'Entry data could not be inflated');
      }
      if (datos.length !== e.usize) fallar('ZIP_TAMANO', 'Entry size does not match the declared size');
    }
    total += datos.length;
    if (total > lim.maxTotal) fallar('ZIP_GRANDE', 'Uncompressed size exceeds the limit');
    if ((crc32(datos) >>> 0) !== e.crc) fallar('ZIP_CORRUPTO', 'Entry checksum mismatch');
    salida.set(e.nombre, datos);
  }
  return salida;
}

export function reemplazarEntradas(buf, cambios, opciones = {}) {
  const { entradas } = analizar(buf, opciones);
  const existentes = new Set(entradas.map((e) => e.nombre));
  for (const [nombre, datos] of cambios) {
    if (!Buffer.isBuffer(datos) && typeof datos !== 'string') fallar('ZIP_CORRUPTO', 'Replacement data must be a buffer or string');
    if (!existentes.has(nombre) && rutaInvalida(nombre)) fallar('ZIP_RUTA', 'Invalid entry path');
  }
  const piezas = entradas.map((e) => {
    if (cambios.has(e.nombre)) return codificar(e.nombre, cambios.get(e.nombre), e.metodo !== 0);
    return {
      local: buf.subarray(e.offset, e.inicio),
      cuerpo: buf.subarray(e.inicio, e.fin),
      central: buf.subarray(e.pos, e.pos + e.largo),
    };
  });
  for (const [nombre, datos] of cambios) {
    if (!existentes.has(nombre)) piezas.push(codificar(nombre, datos));
  }
  return ensamblar(piezas);
}
