"""Generate a local, keyboard-friendly label review page."""

from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path

from .dataset import manifest_fingerprint
from .isolation import HERE, safe_output
from .manifest import load_manifest, resolve_image
from .taxonomy import DECISION_SCHEMA_VERSION, QUALITY_FLAGS


def _incomplete(case: dict) -> bool:
    labels = case["labels"]
    asset = labels.get("asset")
    if asset == "other":
        # View, orientation and jewellery-specific quality flags are not
        # applicable once the product is confidently outside our taxonomy.
        required = ["asset", "suitable"]
    elif asset in ("ring", "gemstone"):
        required = ["asset", "view", "rotation", "suitable", "quality"]
    else:
        required = ["asset", "view", "rotation", "suitable", "quality"]
    return any(labels.get(field) is None for field in required)


def build_page(manifest_path: Path, output: Path, *, incomplete_only=True,
               source: str | None = None, asset: str | None = None) -> int:
    manifest_path = manifest_path.resolve()
    manifest = load_manifest(manifest_path)
    output = safe_output(output, HERE / "review")
    output.parent.mkdir(parents=True, exist_ok=True)
    cases = []
    for case in manifest["cases"]:
        if incomplete_only and not _incomplete(case):
            continue
        if source and case["source"] != source:
            continue
        if asset and case["labels"].get("asset") != asset:
            continue
        record = {
            "id": case["id"], "sha256": case["sha256"],
            "source": case["source"], "labels": case["labels"],
            "image": Path(os.path.relpath(
                resolve_image(manifest_path, manifest, case), output.parent
            )).as_posix(),
        }
        cases.append(record)
    payload = json.dumps(cases, separators=(",", ":")).replace("</", "<\\/")
    fingerprint = manifest_fingerprint(manifest)
    flags = json.dumps(list(QUALITY_FLAGS))
    title = html.escape(manifest_path.name)
    page = REVIEW_HTML.replace("__TITLE__", title)
    page = page.replace("__FINGERPRINT__", fingerprint)
    page = page.replace("__DECISION_SCHEMA__", str(DECISION_SCHEMA_VERSION))
    page = page.replace("__CASES__", payload).replace("__FLAGS__", flags)
    output.write_text(page)
    return len(cases)


REVIEW_HTML = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product validator review — __TITLE__</title>
<style>
:root{color-scheme:dark;font:15px/1.4 system-ui,sans-serif;background:#11151a;color:#edf1f5}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto 1fr}
header{padding:10px 16px;border-bottom:1px solid #303842;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header strong{font-size:17px}.muted{color:#99a5b2;font-size:13px}.spacer{flex:1}
button{border:1px solid #44505e;background:#202731;color:#eef3f7;border-radius:6px;padding:8px 11px;cursor:pointer}
button:hover{background:#2a3541}.primary{background:#b98b30;color:#101215;border-color:#d2a94f;font-weight:700}
main{min-height:0;display:grid;grid-template-columns:minmax(420px,1fr) 470px}
.stage{min-height:0;display:grid;place-items:center;padding:20px;background-color:#252525;background-image:linear-gradient(45deg,#303030 25%,transparent 25%),linear-gradient(-45deg,#303030 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#303030 75%),linear-gradient(-45deg,transparent 75%,#303030 75%);background-size:28px 28px;background-position:0 0,0 14px,14px -14px,-14px 0}
.stage img{display:block;max-width:100%;max-height:calc(100vh - 100px);object-fit:contain;filter:drop-shadow(0 5px 12px #0007)}
aside{overflow:auto;padding:18px;border-left:1px solid #303842;background:#171c22}
h2{margin:0 0 4px;font-size:16px;word-break:break-word}fieldset{border:1px solid #35404c;border-radius:8px;margin:17px 0;padding:12px}
legend{color:#aeb8c2;padding:0 6px}.choices{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
label.choice{display:flex;gap:8px;align-items:center;padding:9px;border:1px solid #36414d;border-radius:6px;background:#1d242c;cursor:pointer}
label.choice:has(input:checked){border-color:#d0a243;background:#3a3020}input{accent-color:#d0a243}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;position:sticky;bottom:0;background:#171c22;padding:12px 0 2px}
.wide{grid-column:1/-1}.status{min-height:22px;color:#f1bd57}.danger{color:#ff8f8f}
.quick-panel{margin:16px 0 12px;padding:13px;border:1px solid #475463;border-radius:10px;background:#1b222a}
.quick-heading{display:flex;align-items:baseline;gap:9px;margin-bottom:10px}.quick-heading strong{font-size:16px}.quick-heading span{color:#9da9b5;font-size:12px}
.rotation-note{margin-top:10px;color:#b8c2cc;font-size:12px}.rotation-note strong{color:#e0e6eb}
.quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.preset{min-height:42px;text-align:left;padding:7px 9px;font-weight:650;line-height:1.2}.preset kbd{float:right;margin-left:5px}
.preset.good{border-color:#448c65;background:#173326}.preset.good:hover{background:#1d4632}.preset.bad{border-color:#86555a;background:#342126}.preset.bad:hover{background:#48282e}.preset.other{grid-column:1/-1;border-color:#7d6d4c;background:#312b20}
.preset.fixable{border-color:#a77d38;background:#3b2f1b}.preset.fixable:hover{background:#504022}
details{border-top:1px solid #303842;margin-top:13px;padding-top:11px}summary{cursor:pointer;color:#c4ced7;font-weight:650;padding:6px 0}.details-body{padding-top:2px}
kbd{background:#303945;border:1px solid #495564;border-radius:4px;padding:1px 5px;font:12px monospace}
@media(max-width:850px){main{grid-template-columns:1fr;grid-template-rows:50vh auto}.stage img{max-height:45vh}aside{border-left:0;border-top:1px solid #303842}}
</style>
</head>
<body>
<header><strong>Validator data review</strong><span id="progress" class="muted"></span><span class="spacer"></span><button id="undo">Undo last</button><button id="previous">← Previous</button><button id="next">Next →</button><button id="export">Export decisions</button></header>
<main>
 <section class="stage"><img id="product" alt="Product being reviewed"></section>
 <aside>
  <h2 id="caseId"></h2><div id="source" class="muted"></div>
  <section class="quick-panel">
   <div class="quick-heading"><strong>One-click decision</strong><span id="quickAsset"></span></div>
   <div id="quick" class="quick-grid"></div>
   <div class="rotation-note"><strong>Rotation means the correction to apply:</strong> left = 90° counter-clockwise, right = 90° clockwise. Use it only when the camera view is front-facing but the whole image is turned.</div>
  </section>
  <div id="status" class="status"></div>
  <div class="muted">A preset saves immediately and opens the next unreviewed image. Click it or use the key shown on it. <kbd>Backspace</kbd> undoes the last preset.</div>
  <details>
  <summary>Custom decision / multiple problems</summary>
  <div class="details-body">
  <fieldset><legend>Product type</legend><div class="choices">
   <label class="choice"><input type="radio" name="asset" value="ring"> Ring</label>
   <label class="choice"><input type="radio" name="asset" value="gemstone"> Loose gemstone</label>
   <label class="choice"><input type="radio" name="asset" value="other"> Other product</label>
   <label class="choice"><input type="radio" name="asset" value=""> Unknown</label>
  </div></fieldset>
  <fieldset><legend>Camera view</legend><div class="choices">
   <label class="choice"><input type="radio" name="view" value="front"> Front</label>
   <label class="choice"><input type="radio" name="view" value="side"> Side</label>
   <label class="choice"><input type="radio" name="view" value="angled"> Angled</label>
   <label class="choice"><input type="radio" name="view" value="rear"> Rear</label>
   <label class="choice wide"><input type="radio" name="view" value=""> Not applicable / unknown</label>
  </div></fieldset>
  <fieldset><legend>In-plane orientation correction</legend><div class="choices">
   <label class="choice"><input type="radio" name="rotation" value="none"> Already upright</label>
   <label class="choice"><input type="radio" name="rotation" value="rotate_left"> Rotate left to fix</label>
   <label class="choice"><input type="radio" name="rotation" value="rotate_right"> Rotate right to fix</label>
   <label class="choice"><input type="radio" name="rotation" value="half_turn"> Rotate 180° to fix</label>
   <label class="choice wide"><input type="radio" name="rotation" value=""> Not applicable / unknown</label>
  </div></fieldset>
  <fieldset><legend>Usable for VTO after the stated orientation correction?</legend><div class="choices">
   <label class="choice"><input type="radio" name="suitable" value="true"> Yes</label>
   <label class="choice"><input type="radio" name="suitable" value="false"> No</label>
   <label class="choice wide"><input type="radio" name="suitable" value=""> Unknown</label>
  </div></fieldset>
  <fieldset><legend>Quality problems (leave clear when none)</legend><div id="quality" class="choices"></div></fieldset>
  <div class="muted"><kbd>Enter</kbd> saves this custom combination. “Other” automatically sets unsuitable and makes view not applicable.</div>
  <div class="actions"><button id="clear">Clear this decision</button><button id="save" class="primary">Save & next</button></div>
  </div>
  </details>
 </aside>
</main>
<script>
const cases=__CASES__, flags=__FLAGS__, fingerprint='__FINGERPRINT__';
const storageKey='product-validator-review:'+fingerprint;
let decisions=JSON.parse(localStorage.getItem(storageKey)||'{}'), undoState=null;
let index=Math.max(0,cases.findIndex(item=>!decisions[item.id]));
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const quality=$('#quality');
for(const flag of flags){const label=document.createElement('label');label.className='choice';label.innerHTML=`<input type="checkbox" name="quality" value="${flag}"> ${flag.replaceAll('_',' ')}`;quality.append(label)}
const quickPresets=[
 {key:'1',label:'Front · Use',view:'front',rotation:'none',suitable:true,quality:[],tone:'good'},
 {key:'2',label:'Front · Reject',view:'front',rotation:'none',suitable:false,quality:[],tone:'bad'},
 {key:'q',keyLabel:'Q',label:'↺ Rotate left to fix',view:'front',rotation:'rotate_left',suitable:true,quality:[],tone:'fixable'},
 {key:'e',keyLabel:'E',label:'↻ Rotate right to fix',view:'front',rotation:'rotate_right',suitable:true,quality:[],tone:'fixable'},
 {key:'h',keyLabel:'H',label:'Half-turn to fix',view:'front',rotation:'half_turn',suitable:true,quality:[],tone:'fixable'},
 {key:'3',label:'Angled · Reject',view:'angled',rotation:'none',suitable:false,quality:[],tone:'bad'},
 {key:'4',label:'Side · Reject',view:'side',rotation:'none',suitable:false,quality:[],tone:'bad'},
 {key:'5',label:'Rear · Reject',view:'rear',rotation:'none',suitable:false,quality:[],tone:'bad'},
 {key:'6',label:'Multiple products',view:'front',rotation:'none',suitable:false,quality:['multiple_products'],tone:'bad'},
 {key:'7',label:'Cropped',view:'front',rotation:'none',suitable:false,quality:['cropped'],tone:'bad'},
 {key:'8',label:'Occluded',view:'front',rotation:'none',suitable:false,quality:['occluded'],tone:'bad'},
 {key:'9',label:'Low quality',view:'front',rotation:'none',suitable:false,quality:['low_quality'],tone:'bad'},
 {key:'l',keyLabel:'L',label:'Lifestyle image',view:'front',rotation:'none',suitable:false,quality:['lifestyle_image'],tone:'bad'},
 {key:'0',label:'Other product',asset:'other',view:null,rotation:null,suitable:false,quality:[],tone:'other'}
];
const quick=$('#quick');
for(const preset of quickPresets){const button=document.createElement('button');button.type='button';button.className=`preset ${preset.tone}`;button.dataset.preset=preset.key;button.innerHTML=`<span></span><kbd>${preset.keyLabel||preset.key}</kbd>`;button.onclick=()=>applyPreset(preset);quick.append(button)}
function value(name){const input=$(`input[name="${name}"]:checked`);return input?input.value:null}
function setRadio(name,value){for(const el of $$(`input[name="${name}"]`))el.checked=el.value===(value??'')}
function currentLabels(){const suitable=value('suitable');return {asset:value('asset')||null,view:value('view')||null,rotation:value('rotation')||null,suitable:suitable===''||suitable===null?null:suitable==='true',quality:$$('input[name="quality"]:checked').map(x=>x.value)}}
function preferredAsset(item){if(item.labels.asset==='ring'||item.labels.asset==='gemstone')return item.labels.asset;if(item.source.includes('gem')||item.source.includes('commons'))return 'gemstone';return 'ring'}
function assetName(asset){return asset==='gemstone'?'Gemstone':'Ring'}
function render(){if(!cases.length){$('#caseId').textContent='Nothing to review';$('#product').removeAttribute('src');return}const item=cases[index], saved=decisions[item.id], labels=saved?saved.labels:item.labels, suggested=preferredAsset(item);$('#caseId').textContent=item.id;$('#source').textContent=item.source;$('#product').src=encodeURI(item.image);setRadio('asset',labels.asset);setRadio('view',labels.view);setRadio('rotation',labels.rotation);setRadio('suitable',labels.suitable===null?'':String(labels.suitable));for(const el of $$('input[name="quality"]'))el.checked=Array.isArray(labels.quality)&&labels.quality.includes(el.value);const savedCount=cases.reduce((count,entry)=>count+(decisions[entry.id]?1:0),0);$('#progress').textContent=`${index+1} / ${cases.length} · ${savedCount} saved · ${cases.length-savedCount} remaining`;$('#status').textContent=saved?'Saved':'';$('#quickAsset').textContent=`Presets use ${assetName(suggested)}`;for(const button of $$('.preset')){const preset=quickPresets.find(item=>item.key===button.dataset.preset);button.querySelector('span').textContent=preset.asset==='other'?preset.label:`${assetName(suggested)} · ${preset.label}`}const next=nextUnreviewed(index);if(next!==null){const preload=new Image();preload.src=encodeURI(cases[next].image)}}
function navigate(delta){index=(index+delta+cases.length)%cases.length;render()}
function nextUnreviewed(from){for(let offset=1;offset<=cases.length;offset++){const candidate=(from+offset)%cases.length;if(!decisions[cases[candidate].id])return candidate}return null}
function persist(){localStorage.setItem(storageKey,JSON.stringify(decisions))}
function commit(labels){const item=cases[index];undoState={id:item.id,index,previous:decisions[item.id]||null};decisions[item.id]={id:item.id,sha256:item.sha256,labels};persist();const next=nextUnreviewed(index);if(next===null){render();show('All images reviewed. Export the decisions JSON.')}else{index=next;render()}}
function applyPreset(preset){if(!cases.length)return;const asset=preset.asset||preferredAsset(cases[index]);commit({asset,view:preset.view,rotation:preset.rotation,suitable:preset.suitable,quality:[...preset.quality]})}
function save(){const labels=currentLabels();if(labels.asset==='other'){labels.view=null;labels.rotation=null;labels.suitable=false}if(!labels.asset){show('Choose a product type.',true);return}if(labels.asset!=='other'&&!labels.view){show('Choose the camera view.',true);return}if(labels.asset!=='other'&&!labels.rotation){show('Choose the orientation correction.',true);return}if(labels.rotation!=='none'&&labels.view!=='front'){show('Rotation correction is only valid for a front camera view.',true);return}if(labels.suitable===null){show('Choose whether VTO can use it after correction.',true);return}commit(labels)}
function undoLast(){if(!undoState){show('Nothing to undo.');return}if(undoState.previous)decisions[undoState.id]=undoState.previous;else delete decisions[undoState.id];index=undoState.index;undoState=null;persist();render();show('Last decision undone.')}
function show(message,error=false){$('#status').textContent=message;$('#status').className=error?'status danger':'status'}
function exportData(){const payload={schema_version:__DECISION_SCHEMA__,manifest_fingerprint:fingerprint,created_at:new Date().toISOString(),decisions:cases.map(item=>decisions[item.id]).filter(Boolean)};const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='product-validator-decisions.json';a.click();URL.revokeObjectURL(a.href)}
$('#undo').onclick=undoLast;$('#previous').onclick=()=>navigate(-1);$('#next').onclick=()=>navigate(1);$('#save').onclick=save;$('#export').onclick=exportData;$('#clear').onclick=()=>{if(!cases.length)return;delete decisions[cases[index].id];persist();render()};
document.addEventListener('change',e=>{if(e.target.name==='asset'&&e.target.value==='other'){setRadio('view','');setRadio('rotation','');setRadio('suitable','false')}});
document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const key=e.key.toLowerCase(),preset=quickPresets.find(item=>item.key===key);if(e.key==='ArrowLeft')navigate(-1);else if(e.key==='ArrowRight')navigate(1);else if(e.key==='Backspace'){e.preventDefault();undoLast()}else if(e.key==='Enter')save();else if(preset)applyPreset(preset)});
render();
</script>
</body></html>'''


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", default="product_validator/review/index.html")
    parser.add_argument("--source")
    parser.add_argument("--asset", choices=("ring", "gemstone", "other"))
    parser.add_argument("--all", action="store_true",
                        help="include fully labeled records too")
    return parser.parse_args()


def main():
    args = parse_args()
    count = build_page(Path(args.manifest), Path(args.output),
                       incomplete_only=not args.all, source=args.source,
                       asset=args.asset)
    print(json.dumps({"output": str(Path(args.output).resolve()),
                      "case_count": count}, indent=2))


if __name__ == "__main__":
    main()
