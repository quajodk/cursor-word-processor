import { readdirSync, readFileSync, statSync } from "node:fs";
import { importDocx } from "../src/import";
const dir="corpus/docx";
const files=readdirSync(dir).filter(f=>f.endsWith(".docx"))
  .map(f=>({f,size:statSync(`${dir}/${f}`).size})).sort((a,b)=>b.size-a.size).slice(0,6);
for(const {f} of files){
  const b=new Uint8Array(readFileSync(`${dir}/${f}`));
  importDocx(b); // warm
  let t=Bun.nanoseconds(); importDocx(b); const on=(Bun.nanoseconds()-t)/1e6;
  t=Bun.nanoseconds(); importDocx(b,{hashParts:false}); const off=(Bun.nanoseconds()-t)/1e6;
  console.log(`hash=${on.toFixed(0).padStart(5)}ms  nohash=${off.toFixed(0).padStart(5)}ms  saved=${(100-off/on*100).toFixed(0).padStart(3)}%  ${f.slice(0,32)}`);
}
