import { readdirSync, readFileSync } from "node:fs";
import { importDocx } from "../src/import";
const dir="corpus/docx"; const all=readdirSync(dir).filter(f=>f.endsWith(".docx"));
// warm the JIT thoroughly on a few documents first
for(const f of all.slice(0,4)){ const b=new Uint8Array(readFileSync(`${dir}/${f}`)); try{importDocx(b);}catch{} }
const rows:{f:string;ms:number;p:number}[]=[];
for(const f of all){
  const b=new Uint8Array(readFileSync(`${dir}/${f}`));
  let r; const t=Bun.nanoseconds(); try{ r=importDocx(b);}catch{continue;}
  const ms=(Bun.nanoseconds()-t)/1e6;
  let p=0; r.doc.descendants(n=>{if(n.type.name==="paragraph")p++;return true;});
  if(p>=500) rows.push({f,ms,p});
}
rows.sort((a,b)=>b.ms-a.ms);
const v=rows.map(r=>r.ms).sort((a,b)=>a-b);
const q=(x:number)=>v[Math.min(v.length-1,Math.floor(x*v.length))]!;
console.log(`large-band files: ${rows.length}`);
console.log(`  p50=${q(.5).toFixed(0)}ms  p95=${q(.95).toFixed(0)}ms  p99=${q(.99).toFixed(0)}ms  max=${v[v.length-1]!.toFixed(0)}ms`);
console.log(`  slowest 5:`);
rows.slice(0,5).forEach(r=>console.log(`    ${r.ms.toFixed(0).padStart(5)}ms ${String(r.p).padStart(5)}p  ${r.f.slice(0,44)}`));
