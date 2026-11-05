// Pins the process time zone for one test and restores it afterwards.
export function fijarTz(t, tz) {
  const previo = process.env.TZ;
  process.env.TZ = tz;
  t.after(() => { previo === undefined ? delete process.env.TZ : (process.env.TZ = previo); });
}

// Restores an environment variable after the test.
export function fijarEnv(t, nombre, valor) {
  const previo = process.env[nombre];
  if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
  t.after(() => { previo === undefined ? delete process.env[nombre] : (process.env[nombre] = previo); });
}
