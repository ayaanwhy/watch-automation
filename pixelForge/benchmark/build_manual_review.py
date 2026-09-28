#!/usr/bin/env python3
"""Build a standalone visual-review UI and a risk-prioritized contact sheet."""

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from vto.post import decontaminate


def browser_relative_path(target, base):
    """Return a browser-safe path from an offline page to a local asset."""
    return Path(os.path.relpath(Path(target).resolve(), Path(base).resolve())).as_posix()


def fit_tile(image, size=320):
    canvas = np.full((size, size, 3), 31, np.uint8)
    height, width = image.shape[:2]
    scale = min((size - 32) / max(height, 1), size / max(width, 1))
    resized = cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
    )
    y = 32 + max(0, (size - 32 - resized.shape[0]) // 2)
    x = max(0, (size - resized.shape[1]) // 2)
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def labelled(tile, text):
    tile = tile.copy()
    cv2.rectangle(tile, (0, 0), (tile.shape[1], 31), (31, 31, 31), -1)
    cv2.putText(tile, text[:48], (7, 21), cv2.FONT_HERSHEY_SIMPLEX,
                0.45, (245, 245, 245), 1, cv2.LINE_AA)
    return tile


def dark_composite(source, mask):
    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    return np.clip(source * alpha + 31 * (1 - alpha), 0, 255).astype(np.uint8)


def visual_risk(source, full_mask, back_mask, metrics, expect_back=True):
    """Rank cases for review; this is triage, not a pass/fail decision."""
    solid = full_mask > 127
    height, width = solid.shape
    border = np.concatenate((source[0], source[-1], source[:, 0], source[:, -1]))
    background_bgr = np.median(border, axis=0).astype(np.uint8)
    lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB).astype(np.float32)
    background_lab = cv2.cvtColor(background_bgr[None, None], cv2.COLOR_BGR2LAB)[0, 0]
    background_like = np.linalg.norm(lab - background_lab, axis=2) < 13

    count, labels = cv2.connectedComponents(background_like.astype(np.uint8), 8)
    border_labels = np.unique(np.concatenate(
        (labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    connected_background = np.isin(labels, border_labels[border_labels > 0])

    inner_distance = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 3)
    outer_distance = cv2.distanceTransform((~solid).astype(np.uint8), cv2.DIST_L2, 3)
    inner_edge = solid & (inner_distance <= 3.0)
    outer_edge = (~solid) & (outer_distance <= 3.0)
    retained = int((inner_edge & connected_background).sum())
    missed = int((outer_edge & ~background_like).sum())
    edge_px = max(int(inner_edge.sum()), 1)

    retained_ratio = retained / edge_px
    missed_ratio = missed / edge_px
    back_fraction = float(metrics.get("back_fraction", 0))
    margins = metrics.get("bbox_margins", {})
    minimum_margin = min(margins.values()) if margins else 0
    margin_risk = max(0, 8 - minimum_margin) / 8
    back_risk = max(0, 0.08 - back_fraction) / 0.08 if expect_back else 0.0
    if expect_back:
        component_count, _, component_stats, _ = cv2.connectedComponentsWithStats(
            (back_mask > 127).astype(np.uint8), 8)
        back_areas = component_stats[1:, cv2.CC_STAT_AREA].tolist()
        tiny_back_components = sum(area < 20 for area in back_areas)
        small_back_components = sum(area < 100 for area in back_areas)
    else:
        component_count, tiny_back_components, small_back_components = 1, 0, 0
    score = (4.0 * retained_ratio + 3.0 * missed_ratio + back_risk + margin_risk +
             0.8 * tiny_back_components + 0.15 * small_back_components)
    return {
        "score": round(float(score), 6),
        "retained_bg_edge_ratio": round(float(retained_ratio), 6),
        "missed_fg_edge_ratio": round(float(missed_ratio), 6),
        "minimum_margin": int(minimum_margin),
        "back_components": max(component_count - 1, 0),
        "tiny_back_components": int(tiny_back_components),
        "small_back_components": int(small_back_components),
    }


def write_priority_pages(cases, output_dir, page_size=15):
    paths = []
    for offset in range(0, len(cases), page_size):
        rows = [case.pop("_row") for case in cases[offset:offset + page_size]]
        page = np.concatenate(rows, axis=0)
        name = f"manual_priority_{offset // page_size + 1:03d}.jpg"
        cv2.imwrite(str(output_dir / name), page, [cv2.IMWRITE_JPEG_QUALITY, 94])
        paths.append(name)
    for case in cases:
        case.pop("_row", None)
    return paths


HTML = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JewelSense manual segmentation review</title>
<style>
:root{color-scheme:dark;--zoom:1;font-family:Inter,system-ui,sans-serif}
*{box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}
body{margin:0;background:#111;color:#eee;display:flex;flex-direction:column;max-width:100vw}
header{position:relative;z-index:5;flex:none;background:#181818;border-bottom:1px solid #444;padding:7px 10px}
.toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.toolbar+.toolbar{margin-top:6px}
button,input,select,summary{font:inherit;color:inherit;background:#282828;border:1px solid #555;border-radius:5px;padding:6px 9px}
button,summary{cursor:pointer}button:hover,summary:hover{background:#333}
.primary{border-color:#71a7ff}.danger{border-color:#ff7777}.good{border-color:#69d28a}.active{background:#38577d}
#search{width:190px}.notes{flex:1;min-width:190px}.spacer{flex:1}
#progress{font-variant-numeric:tabular-nums;white-space:nowrap}
.zoom-tools{display:flex;align-items:center;gap:4px}.zoom-tools button{min-width:34px}.zoom-tools input{width:105px;padding:0}.zoom-tools output{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
.casebar{position:relative;z-index:4;flex:none;display:flex;gap:10px;align-items:center;padding:6px 10px;border-bottom:1px solid #333;background:#151515;min-width:0}
#caseId{white-space:nowrap}.risk{color:#ffc66d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.details{margin-left:auto;position:relative;flex:none}.details summary{list-style:none}.details summary::-webkit-details-marker{display:none}
.detail-popover{position:absolute;right:0;top:calc(100% + 7px);width:min(920px,calc(100vw - 20px));max-height:62vh;overflow:auto;display:grid;grid-template-columns:minmax(260px,1fr) minmax(320px,1.5fr);gap:8px;padding:8px;background:#171717;border:1px solid #555;border-radius:7px;box-shadow:0 12px 35px #000b}
.card{margin:0;background:#202020;border:1px solid #383838;border-radius:6px;padding:9px;white-space:pre-wrap;overflow:auto;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:0 10px 10px}
.panel{min-width:0;min-height:0;display:flex;flex-direction:column}.panel h3{flex:none;margin:6px 2px 5px;font-size:13px}
.viewport{--fit:320px;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;border:1px solid #444;border-radius:6px;background:#1f1f1f;scrollbar-color:#666 #222}
.zoomspace{width:max(100%,calc(var(--fit)*var(--zoom)));height:max(100%,calc(var(--fit)*var(--zoom)));display:flex;align-items:center;justify-content:center}
.stage{flex:none;width:calc(var(--fit)*var(--zoom));height:calc(var(--fit)*var(--zoom));background-color:#1f1f1f;background-position:center;background-size:100% 100%;background-repeat:no-repeat}
.masked{width:100%;height:100%;background-size:100% 100%;background-repeat:no-repeat}
body[data-bg="white"] .stage{background-color:#fff}
body[data-bg="checker"] .stage{background-color:#ddd;background-image:linear-gradient(45deg,#aaa 25%,transparent 25%),linear-gradient(-45deg,#aaa 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#aaa 75%),linear-gradient(-45deg,transparent 75%,#aaa 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}
.panel-tabs{display:none;flex:none;padding:6px 10px 0;gap:5px;background:#111}.panel-tabs button{flex:1}
@media(max-width:1199px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){header{padding:6px}.toolbar{gap:4px}.hide-small{display:none}#search{flex:1;width:auto;min-width:120px}.casebar{padding:5px 7px}.casebar #caseId{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.risk{display:none}.details{margin-left:0}.detail-popover{width:calc(100vw - 14px);grid-template-columns:1fr}.panel-tabs{display:flex}.grid{display:block;padding:0 7px 7px}.panel{height:100%;display:none}.panel.mobile-active{display:flex}.zoom-tools input{width:80px}}
@media(max-height:650px){header{padding:5px 8px}.toolbar+.toolbar{margin-top:4px}.casebar{padding-top:4px;padding-bottom:4px}.panel h3{margin-top:3px}}
</style>
</head>
<body data-bg="dark">
<header><div class="toolbar">
<button id="prev">← Prev</button><button id="next">Next →</button>
<input id="search" placeholder="Search case/config">
<select id="filter"><option value="all">All cases</option><option value="unreviewed">Unreviewed</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="inspect">Needs inspection</option></select>
<select id="sort" class="hide-small"><option value="risk">Highest risk first</option><option value="suite">Suite order</option></select>
<span class="hide-small"><button data-bg="dark" class="bg active">Dark</button> <button data-bg="checker" class="bg">Checker</button> <button data-bg="white" class="bg">White</button></span>
<span class="spacer"></span>
<span class="zoom-tools"><button id="zoomOut" title="Zoom out">−</button><button id="zoomFit" title="Fit all panels">Fit</button><button id="zoomIn" title="Zoom in">+</button><input id="zoom" aria-label="Zoom" type="range" min="1" max="4" step=".25" value="1"><output id="zoomValue">100%</output></span>
<span id="progress"></span>
</div><div class="toolbar" style="margin-top:8px">
<button id="approve" class="good">A — Approve</button><button id="inspect" class="primary">I — Inspect</button><button id="reject" class="danger">R — Reject</button><button id="clear">Clear</button><button id="export">Export decisions JSON</button>
<input id="notes" class="notes" placeholder="Notes for this case">
</div></header>
<section class="casebar"><strong id="caseId"></strong><span class="risk" id="risk"></span><details class="details"><summary>Details</summary><div class="detail-popover"><pre class="card" id="metrics"></pre><pre class="card" id="selected"></pre></div></details></section>
<nav class="panel-tabs" aria-label="Image panels"><button data-panel="source" class="active">Source</button><button data-panel="full">Full</button><button data-panel="front">Front</button><button data-panel="back">Back</button></nav>
<section class="grid">
<div class="panel mobile-active" data-panel="source"><h3>Original source</h3><div class="viewport"><div class="zoomspace"><div id="source" class="stage source"></div></div></div></div>
<div class="panel" data-panel="full"><h3>Full segmentation</h3><div class="viewport"><div class="zoomspace"><div class="stage"><div id="full" class="masked"></div></div></div></div></div>
<div class="panel" data-panel="front"><h3>Front layer</h3><div class="viewport"><div class="zoomspace"><div class="stage"><div id="front" class="masked"></div></div></div></div></div>
<div class="panel" data-panel="back"><h3>Back layer</h3><div class="viewport"><div class="zoomspace"><div class="stage"><div id="back" class="masked"></div></div></div></div></div>
</section>
<script>
const CASES=__CASES__;
const SNAPSHOT=__SNAPSHOT__;
const RUNTIME=__RUNTIME__;
const STORAGE=`jewelsense-review:${SNAPSHOT}:${RUNTIME}`;
let decisions=JSON.parse(localStorage.getItem(STORAGE)||'{}');let visible=[];let pos=0;
const $=id=>document.getElementById(id);
function save(){localStorage.setItem(STORAGE,JSON.stringify(decisions));updateProgress()}
function searchable(c){return `${c.id} ${JSON.stringify(c.selected)}`.toLowerCase()}
function rebuild(keepId){const q=$('search').value.toLowerCase();const f=$('filter').value;visible=CASES.filter(c=>searchable(c).includes(q)&& (f==='all'||(f==='unreviewed'&&!decisions[c.id])||decisions[c.id]?.status===f));if($('sort').value==='risk')visible.sort((a,b)=>b.visual_risk.score-a.visual_risk.score||a.index-b.index);else visible.sort((a,b)=>a.index-b.index);let found=visible.findIndex(c=>c.id===keepId);pos=found>=0?found:Math.min(pos,Math.max(visible.length-1,0));render()}
function layer(el,image){el.style.backgroundImage=`url("${image}")`;el.style.maskImage='none';el.style.webkitMaskImage='none'}
function centrePanels(){requestAnimationFrame(()=>document.querySelectorAll('.viewport').forEach(view=>{view.scrollLeft=(view.scrollWidth-view.clientWidth)/2;view.scrollTop=(view.scrollHeight-view.clientHeight)/2}))}
function render(){if(!visible.length){$('caseId').textContent='No matching cases';return}const c=visible[pos],d=decisions[c.id]||{};$('caseId').textContent=`${pos+1}/${visible.length} · ${c.id}`;const layerNote=c.asset_type==='ring'?` · back components ${c.visual_risk.back_components} (${c.visual_risk.tiny_back_components} tiny)`:' · matte-only gemstone';$('risk').textContent=`Priority ${c.visual_risk.score} · retained background ${c.visual_risk.retained_bg_edge_ratio} · missed foreground ${c.visual_risk.missed_fg_edge_ratio}${layerNote}`;$('metrics').textContent=JSON.stringify(c.metrics,null,2);$('selected').textContent=JSON.stringify(c.selected,null,2);$('source').style.backgroundImage=`url("${c.source}")`;layer($('full'),c.layers.full);layer($('front'),c.layers.front);layer($('back'),c.layers.back);$('notes').value=d.notes||'';for(const id of ['approve','inspect','reject'])$(id).classList.toggle('active',d.status===id.replace('approve','approved').replace('reject','rejected'));updateProgress();centrePanels()}
function decide(status){if(!visible.length)return;const c=visible[pos];decisions[c.id]={status,notes:$('notes').value,updated_at:new Date().toISOString()};save();if($('filter').value==='unreviewed')rebuild();else{pos=Math.min(pos+1,visible.length-1);render()}}
function updateProgress(){const counts={approved:0,rejected:0,inspect:0};Object.values(decisions).forEach(d=>{if(counts[d.status]!=null)counts[d.status]++});$('progress').textContent=`${Object.keys(decisions).length}/${CASES.length} reviewed · ✓${counts.approved} · !${counts.inspect} · ✕${counts.rejected}`}
function setZoom(value){value=Math.max(1,Math.min(4,Number(value)));document.documentElement.style.setProperty('--zoom',value);$('zoom').value=value;$('zoomValue').value=`${Math.round(value*100)}%`;centrePanels()}
function fitPanels(){document.querySelectorAll('.viewport').forEach(view=>{const size=Math.max(1,Math.floor(Math.min(view.clientWidth,view.clientHeight)));view.style.setProperty('--fit',`${size}px`)});centrePanels()}
function selectPanel(name){document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('mobile-active',panel.dataset.panel===name));document.querySelectorAll('.panel-tabs button').forEach(button=>button.classList.toggle('active',button.dataset.panel===name));requestAnimationFrame(fitPanels)}
$('prev').onclick=()=>{pos=Math.max(0,pos-1);render()};$('next').onclick=()=>{pos=Math.min(visible.length-1,pos+1);render()};$('approve').onclick=()=>decide('approved');$('inspect').onclick=()=>decide('inspect');$('reject').onclick=()=>decide('rejected');$('clear').onclick=()=>{if(!visible.length)return;delete decisions[visible[pos].id];save();render()};$('notes').onchange=()=>{if(!visible.length)return;const c=visible[pos];decisions[c.id]={...(decisions[c.id]||{status:'inspect'}),notes:$('notes').value,updated_at:new Date().toISOString()};save()};$('search').oninput=()=>rebuild();$('filter').onchange=()=>rebuild();$('sort').onchange=()=>rebuild(visible[pos]?.id);
$('zoom').oninput=e=>setZoom(e.target.value);$('zoomOut').onclick=()=>setZoom(Number($('zoom').value)-.25);$('zoomFit').onclick=()=>setZoom(1);$('zoomIn').onclick=()=>setZoom(Number($('zoom').value)+.25);
document.querySelectorAll('.viewport').forEach(view=>view.ondblclick=()=>setZoom(Number($('zoom').value)===1?2:1));document.querySelectorAll('.panel-tabs button').forEach(button=>button.onclick=()=>selectPanel(button.dataset.panel));document.querySelectorAll('.bg').forEach(b=>b.onclick=()=>{document.body.dataset.bg=b.dataset.bg;document.querySelectorAll('.bg').forEach(x=>x.classList.toggle('active',x===b))});$('export').onclick=()=>{const payload={snapshot:SNAPSHOT,runtime:RUNTIME,exported_at:new Date().toISOString(),decisions};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${SNAPSHOT}-manual-decisions.json`;a.click();URL.revokeObjectURL(a.href)};document.onkeydown=e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key==='ArrowLeft')$('prev').click();if(e.key==='ArrowRight')$('next').click();if(e.key.toLowerCase()==='a')$('approve').click();if(e.key.toLowerCase()==='i')$('inspect').click();if(e.key.toLowerCase()==='r')$('reject').click();if(e.key==='+'||e.key==='=')$('zoomIn').click();if(e.key==='-')$('zoomOut').click();if(e.key==='0')$('zoomFit').click()};
new ResizeObserver(fitPanels).observe(document.querySelector('.grid'));setZoom(1);rebuild();fitPanels();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--priority-cases", type=int, default=45)
    args = parser.parse_args()

    report_path = Path(args.report).resolve()
    output_dir = report_path.parent
    snapshot_dir = Path(args.snapshot).resolve()
    report = json.loads(report_path.read_text())
    cases = []
    layer_dir = output_dir / "manual_layers"
    layer_dir.mkdir(exist_ok=True)
    by_id = {item["id"]: item for item in report["cases"] if item.get("masks")}
    manifest = json.loads((snapshot_dir / "manifest.json").read_text())
    manifest_by_id = {item["id"]: item for item in manifest["cases"]}
    for index, report_case in enumerate(item for item in report["cases"] if item.get("masks")):
        case_id = report_case["id"]
        source = cv2.imread(str(snapshot_dir / report_case["source_file"]), cv2.IMREAD_COLOR)
        masks = {name: cv2.imread(str(output_dir / path), cv2.IMREAD_GRAYSCALE)
                 for name, path in report_case["masks"].items()}
        foreground = decontaminate(source, masks["full"].astype(np.float32) / 255.0)
        layers = {}
        for name, mask in masks.items():
            relative = Path("manual_layers") / f"{case_id}_{name}.webp"
            destination = output_dir / relative
            cv2.imwrite(str(destination), np.dstack((foreground, mask)),
                        [cv2.IMWRITE_WEBP_QUALITY, 95])
            layers[name] = str(relative)
        asset_type = report_case.get("asset_type", report.get("asset_type", "ring"))
        risk = visual_risk(source, masks["full"], masks["back"],
                           report_case["metrics"], expect_back=asset_type == "ring")
        browser_case = {
            "index": index,
            "id": case_id,
            "asset_type": asset_type,
            "source": browser_relative_path(
                snapshot_dir / report_case["source_file"], output_dir),
            "masks": report_case["masks"],
            "layers": layers,
            "selected": report_case.get("selected", manifest_by_id[case_id].get("selected", {})),
            "metrics": report_case["metrics"],
            "visual_risk": risk,
        }
        panels = [
            labelled(fit_tile(source), f"{case_id} source"),
            labelled(fit_tile(dark_composite(source, masks["front"])), "front / dark"),
            labelled(fit_tile(dark_composite(source, masks["back"])), "back / dark"),
            labelled(fit_tile(dark_composite(source, masks["full"])), "full / dark"),
        ]
        browser_case["_row"] = np.concatenate(panels, axis=1)
        cases.append(browser_case)

    cases.sort(key=lambda item: (-item["visual_risk"]["score"], item["index"]))
    priority = cases[:args.priority_cases]
    priority_pages = write_priority_pages(priority, output_dir)
    for case in cases:
        case.pop("_row", None)
    html = (HTML.replace("__CASES__", json.dumps(cases, separators=(",", ":")))
            .replace("__SNAPSHOT__", json.dumps(report["snapshot_id"]))
            .replace("__RUNTIME__", json.dumps(report["runtime"]["signature"])))
    (output_dir / "manual_review.html").write_text(html)
    audit = {
        "schema_version": 1,
        "snapshot_id": report["snapshot_id"],
        "runtime_signature": report["runtime"]["signature"],
        "notice": "Visual risk is a review-priority heuristic, not a pass/fail metric.",
        "priority_pages": priority_pages,
        "cases": [{key: value for key, value in case.items() if key != "_row"}
                  for case in cases],
    }
    (output_dir / "manual_review.json").write_text(json.dumps(audit, indent=2) + "\n")
    print(output_dir / "manual_review.html")
    for page in priority_pages:
        print(output_dir / page)


if __name__ == "__main__":
    main()
