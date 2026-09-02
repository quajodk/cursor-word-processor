import { readdirSync, readFileSync, statSync } from "node:fs";
import { importDocx } from "../src/import";
const dir="corpus/docx";
const files=readdirSync(dir).filter(f=>f.endsWith(".docx"))
  .map(f=>({f,size:statSync(`${dir}/${f}`).size})).sort((a,b)=>b.size-a.size).slice(0,10);
for(const {f,size} of files){
  const b=new Uint8Array(readFileSync(`${dir}/${f}`));
  const t0=Bun.nanoseconds(); let r; try{r=importDocx(b);}catch(e:any){console.log(`  FAIL ${f.slice(0,40)}`);continue;}
  const ms=(Bun.nanoseconds()-t0)/1e6;
  let paras=0; r.doc.descendants(n=>{if(n.type.name==="paragraph")paras++;return true;});
  console.log(`${(size/1024/1024).toFixed(1).padStart(5)}MB ${String(paras).padStart(6)}p ${ms.toFixed(0).padStart(6)}ms  ${(ms/Math.max(1,paras)).toFixed(2)}ms/p  ${f.slice(0,36)}`);
}
