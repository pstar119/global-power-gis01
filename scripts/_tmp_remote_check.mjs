// 临时脚本：核对远端 release 资产长度是否与 packs_manifest.json 一致（只读，用完即删）
import { readFileSync } from "node:fs";

const m = JSON.parse(readFileSync("public/packs_manifest.json", "utf8"));
let ok = 0;
let bad = 0;
for (const p of m.packs) {
  try {
    const r = await fetch(p.downloadUrl, { headers: { Range: "bytes=0-0" } });
    const cr = r.headers.get("content-range");
    const total = cr ? Number(cr.split("/")[1]) : null;
    const match = total === p.bytes;
    if (match) ok += 1;
    else bad += 1;
    console.log(`${match ? "OK  " : "DIFF"} ${p.file} manifest=${p.bytes} remote=${total} http=${r.status}`);
  } catch (e) {
    bad += 1;
    console.log(`ERR  ${p.file} ${e.message}`);
  }
}
console.log(`--- remote ok=${ok} bad=${bad} total=${m.packs.length}`);
