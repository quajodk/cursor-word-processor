import { readdirSync, readFileSync } from "node:fs";
import { importDocx } from "../src/import";
const dir="corpus/docx"; const all=readdirSync(dir).filter(f=>f.endsWith(".docx"));
for(const f of all.slice(0,4)){ try{ importDocx(new Uint8Array(readFileSync(`${dir}/${f}`))); }catch{} }
const rows:{ms:number;p:number}[]=[];
for(const f of all){
  const b=new Uint8Array(readFileSync(`${dir}/${f}`));
  let r; const t=Bun.nanoseconds(); try{ r=importDocx(b);}catch{continue;}
  const ms=(Bun.nanoseconds()-t)/1e6;
  let p=0; r.doc.descendants(n=>{if(n.type.name==="paragraph")p++;return true;});
  rows.push({ms,p});
}
const q=(v:number[],x:number)=>v.length?v.sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor(x*v.length))]!:NaN;
const band=(lo:number,hi:number)=>{const s=rows.filter(r=>r.p>=lo&&r.p<hi); const v=s.map(r=>r.ms);
  console.log(`  ${String(lo).padStart(5)}-${String(hi).padStart(6)}p  n=${String(s.length).padStart(3)}  p50=${q([...v],.5).toFixed(0).padStart(5)}  p95=${q([...v],.95).toFixed(0).padStart(5)}  p99=${q([...v],.99).toFixed(0).padStart(5)}ms`);};
console.log("import time by document size:");
band(0,400); band(400,900); band(900,2500); band(2500,100000);
const per=rows.filter(r=>r.p>50).map(r=>r.ms/r.p);
console.log(`size-independent throughput: p50=${q([...per],.5).toFixed(2)} p95=${q([...per],.95).toFixed(2)} ms/paragraph`);
