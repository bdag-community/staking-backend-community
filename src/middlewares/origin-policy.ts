export function allowedApiOrigin(origin:string|undefined, configured:string|undefined) {
  if(!origin) return true; // CLI/server reads; signed writes still verify identity.
  const allowed=(configured ?? 'http://localhost:8083,http://127.0.0.1:8083,http://localhost:3012,http://127.0.0.1:3012').split(',').map(v=>v.trim()).filter(Boolean);
  return allowed.includes(origin);
}
