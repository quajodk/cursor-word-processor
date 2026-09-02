import { readdirSync, readFileSync, statSync } from "node:fs";
import { unzipSync } from "fflate";
import { XmlIndex } from "../src/xmlindex";
import { importDocx } from "../src/import";
const dir="corpus/docx";
const files=readdirSync(dir).filter(f=>f.endsWith(".docx"))
  .map(f=>({f,size:statSync(`${dir}/${f}`).size})).sort((a,b)=>b.size-a.size).slice(0,6);
for(const {f,size} of files){
  const b=new Uint8Array(readFileSync(`${dir}/${f}`));
  let t=Bun.nanoseconds(); const z=unzipSync(b); const unzipMs=(Bun.nanoseconds()-t)/1e6;
  const k=Object.keys(z).find(k=>/word\/document\d*\.xml$/.test(k))!;
  const docXml=z[k]!;
  t=Bun.nanoseconds(); try{ (XmlIndex as any).parse(docXml); }catch(e:any){ console.log("  index err:", e.message.slice(0,60)); }
  const indexMs=(Bun.nanoseconds()-t)/1e6;
  t=Bun.nanoseconds(); importDocx(b); const totalMs=(Bun.nanoseconds()-t)/1e6;
  console.log(`${(size/1024/1024).toFixed(1).padStart(5)}MB docxml=${(docXml.length/1024).toFixed(0).padStart(5)}KB  unzip=${unzipMs.toFixed(0).padStart(5)}ms index=${indexMs.toFixed(0).padStart(5)}ms total=${totalMs.toFixed(0).padStart(5)}ms  ${f.slice(0,28)}`);
}
