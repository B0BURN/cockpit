// Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID) using only WebCrypto.
const enc = new TextEncoder();
export const b64u = buf => { let s = ""; const b = new Uint8Array(buf); for(let i=0;i<b.length;i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); };
export const unb64u = str => { const s = atob(str.replace(/-/g,"+").replace(/_/g,"/") + "===".slice((str.length+3)%4)); const b = new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i] = s.charCodeAt(i); return b; };
const concat = (...a) => { const n = a.reduce((x,y)=>x+y.length,0), o = new Uint8Array(n); let p = 0; for(const x of a){ o.set(x,p); p += x.length; } return o; };

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF", hash:"SHA-256", salt, info}, key, len*8));
}

export async function encryptPayload(sub, payload){
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, {name:"ECDH", namedCurve:"P-256"}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH", public:uaKey}, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv:nonce}, key, plain));
  const rs = new Uint8Array([0,0,16,0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export async function vapidHeader(endpoint, privJwk, pubB64u, subject){
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({typ:"JWT", alg:"ES256"})));
  const claims = b64u(enc.encode(JSON.stringify({aud, exp: Math.floor(Date.now()/1000) + 12*3600, sub: subject})));
  const key = await crypto.subtle.importKey("jwk", privJwk, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, enc.encode(header+"."+claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${pubB64u}`;
}

// returns the HTTP status from the push service (201 = accepted, 404/410 = subscription gone)
export async function sendPush(sub, message, env){
  const body = await encryptPayload(sub, JSON.stringify(message));
  const auth = await vapidHeader(sub.endpoint, JSON.parse(env.VAPID_PRIVATE_JWK), env.VAPID_PUBLIC, env.VAPID_SUBJECT || "mailto:cockpit@example.com");
  const r = await fetch(sub.endpoint, {method:"POST", headers:{
    "Authorization": auth, "Content-Encoding":"aes128gcm", "Content-Type":"application/octet-stream",
    "TTL": String(message.ttl ?? 6*3600), "Urgency": message.urgency || "high", ...(message.topic? {"Topic": message.topic} : {})}, body});
  return r.status;
}
