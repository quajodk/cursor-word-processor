import { readdirSync, readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { sha256Hex } from "../src/hash";
const f="corpus/docx/Manual-de-Capacitaci-n-sobre-Ciencia-Abierta-para-Bibliotec-b5e2e9d5.docx";
const files=readdirSync("corpus/docx").filter(x=>x.endsWith(".docx"));
const target=files.find(x=>x.startsWith("Manual-de-Capacitaci"))??files[0]!;
const b=new Uint8Array(readFileSync(`corpus/docx/${target}`));
const z=unzipSync(b);
let total=0; for(const k of Object.keys(z)) total+=z[k]!.length;
// warm the JIT first — the previous run measured a cold, unoptimised sha256 and reported
// five seconds of hashing for a file that imports in half a second.
for(let i=0;i<3;i++) for(const k of Object.keys(z)) sha256Hex(z[k]!);
let t=Bun.nanoseconds();
for(const k of Object.keys(z)) sha256Hex(z[k]!);
const partsMs=(Bun.nanoseconds()-t)/1e6;
t=Bun.nanoseconds(); sha256Hex(b); const wholeMs=(Bun.nanoseconds()-t)/1e6;
// per-block anchor hashing cost
const para="Measurements were taken at fourteen fixed transects at monthly intervals, each surveyed using differential GPS.";
t=Bun.nanoseconds(); for(let i=0;i<2600;i++) sha256Hex(para+i); const blocksMs=(Bun.nanoseconds()-t)/1e6;
console.log(`file: ${target.slice(0,40)}`);
console.log(`  zip parts total ${(total/1e6).toFixed(1)}MB across ${Object.keys(z).length} entries`);
console.log(`  sha256 of every part      : ${partsMs.toFixed(0)}ms`);
console.log(`  sha256 of whole docx      : ${wholeMs.toFixed(0)}ms`);
console.log(`  sha256 x2600 short strings: ${blocksMs.toFixed(0)}ms`);
console.log(`  => hashing subtotal        : ${(partsMs+wholeMs+blocksMs).toFixed(0)}ms`);
